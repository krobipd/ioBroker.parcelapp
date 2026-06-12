import * as http from "node:http";
import * as https from "node:https";
import { isTrueish } from "./coerce";
import type { ParcelApiResponse, ParcelDelivery, AddDeliveryRequest, AddDeliveryResponse, CarrierMap } from "./types";

const API_BASE = "https://api.parcel.app/external";
const REQUEST_TIMEOUT = 15_000;

/**
 * v0.4.3: optional logger injected by the adapter so the HTTPS client can
 * trace its own request/response lifecycle. When omitted (e.g. in tests),
 * every `this.log?.debug(...)` call is a no-op — keeps the bare-`apiKey`
 * constructor signature backward-compatible.
 */
export interface ParcelClientLogger {
  /** Adapter debug log. Called at most once per request/response decision. */
  debug(message: string): void;
}
/**
 * v0.4.2 (P9): hard cap on response body size. parcel.app deliveries lists
 * are tiny (~1 kB per package, max ~50 packages = 50 kB), so a 1 MiB cap is
 * 20× the realistic max while still defending against a runaway response.
 */
const MAX_BODY_BYTES = 1 << 20; // 1 MiB

/**
 * Build an `Error` carrying a `code` (and optional extra fields such as
 * `retryAfterSeconds`). Centralizes the `new Error(...) as Error & { code }`
 * + `err.code = …` pattern that was repeated at every throw/reject site.
 *
 * @param message Human-readable error message.
 * @param code Machine-readable error code used by the adapter for classification.
 * @param extra Optional additional own-properties to attach to the error.
 */
function apiError(message: string, code: string, extra?: Record<string, unknown>): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  if (extra) {
    Object.assign(err, extra);
  }
  return err;
}

/** HTTP client for the parcel.app API */
export class ParcelClient {
  private apiKey: string;
  private carrierCache: CarrierMap | null = null;
  /**
   * v0.7.2: in-flight fetch for the carrier list. The per-delivery updates run
   * in parallel (Promise.all) and each resolves carrier names — without this
   * mutex the first poll with N packages fired N identical concurrent fetches
   * of the static 447-entry file (and a persistently failing endpoint was
   * retried N times per poll). Same pattern as beszel's auth mutex (B1).
   */
  private carrierFetchInFlight: Promise<CarrierMap> | null = null;
  /**
   * v0.4.2 (P1): per-request AbortController. `cancelAll()` aborts every
   * pending HTTPS request — called from the adapter's `onUnload` so a slow
   * parcel.app endpoint can't keep the adapter alive past js-controller's
   * 4-second kill deadline.
   */
  private readonly inflight = new Set<AbortController>();
  /** v0.4.3: optional logger for the HTTPS-layer trace. See {@link ParcelClientLogger}. */
  private readonly log?: ParcelClientLogger;
  /** API base URL. Overridable so tests can run the real `request()` against a local mock server. */
  private readonly baseUrl: string;

  /**
   * @param apiKey The parcel.app API key
   * @param log Optional adapter logger for HTTPS-layer trace (v0.4.3)
   * @param baseUrl API base URL — defaults to the production endpoint; overridden in tests
   */
  constructor(apiKey: string, log?: ParcelClientLogger, baseUrl: string = API_BASE) {
    this.apiKey = apiKey;
    this.log = log;
    this.baseUrl = baseUrl;
  }

  /**
   * v0.4.2 (P1): abort every in-flight HTTPS request. Idempotent.
   */
  cancelAll(): void {
    // v0.4.3 (A12): trace the shutdown anchor so the adapter log shows
    // exactly how many HTTPS calls were aborted at unload.
    this.log?.debug(`cancelAll: aborting ${this.inflight.size} inflight requests`);
    for (const ctrl of this.inflight) {
      ctrl.abort();
    }
  }

  /**
   * Fetch deliveries from parcel.app.
   *
   * @param filterMode Filter active or recent deliveries
   */
  async getDeliveries(filterMode: "active" | "recent" = "active"): Promise<ParcelDelivery[]> {
    const response = await this.request<ParcelApiResponse>("GET", `/deliveries/?filter_mode=${filterMode}`, true);

    // API-drift guard: response may be null or a non-object
    if (!response || typeof response !== "object") {
      // v0.4.3 (A11a): trace malformed-response drift before throwing.
      this.log?.debug(`API drift: malformed response (got ${typeof response})`);
      throw apiError("API error: malformed response", "API_ERROR");
    }

    if (!isTrueish(response.success)) {
      const rawCode = typeof response.error_code === "string" ? response.error_code : "";
      const rawMsg = typeof response.error_message === "string" ? response.error_message : "";
      const code = rawCode || rawMsg || "UNKNOWN";
      // v0.4.3 (A11b): trace API-side error before throwing.
      this.log?.debug(`API drift: success=false, code='${code}', msg='${rawMsg}'`);
      throw apiError(`API error: ${rawMsg || code}`, rawCode === "INVALID_API_KEY" ? "INVALID_API_KEY" : "API_ERROR");
    }

    // API-drift guard: deliveries must be an array
    return Array.isArray(response.deliveries) ? response.deliveries : [];
  }

  /**
   * Add a new delivery to parcel.app.
   *
   * @param delivery The delivery to add
   */
  async addDelivery(delivery: AddDeliveryRequest): Promise<AddDeliveryResponse> {
    return this.request<AddDeliveryResponse>("POST", "/add-delivery/", true, delivery);
  }

  /** Get carrier names (cached after first call; concurrent callers share one fetch) */
  async getCarrierNames(): Promise<CarrierMap> {
    if (this.carrierCache) {
      return this.carrierCache;
    }
    // v0.7.2: share one in-flight fetch between the parallel per-delivery
    // updates instead of firing N identical requests on the first poll.
    if (!this.carrierFetchInFlight) {
      this.carrierFetchInFlight = this.fetchCarrierNames().finally(() => {
        this.carrierFetchInFlight = null;
      });
    }
    return this.carrierFetchInFlight;
  }

  /** One actual carrier-list fetch. Failure → empty map, NOT cached (retry next poll). */
  private async fetchCarrierNames(): Promise<CarrierMap> {
    try {
      const raw = await this.request<unknown>("GET", "/supported_carriers.json", false);
      // API-drift guard: must be a plain object (not null, array, or primitive)
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        this.carrierCache = raw as CarrierMap;
        // v0.4.3 (D1): trace the one-time cache fill so a successful warm-up
        // is visible in the debug log (happens once per adapter restart).
        this.log?.debug(`carriers: fetched ${Object.keys(this.carrierCache).length} entries`);
        return this.carrierCache;
      }
      // v0.4.3 (D3): non-object drift — supported_carriers.json returned
      // something that isn't an object. Empty map is returned, NOT cached.
      this.log?.debug(
        `carriers: drift (got ${Array.isArray(raw) ? "array" : typeof raw}, expected object), kept empty`,
      );
      return {};
    } catch (err) {
      // v0.4.3 (D2): trace the fetch-fail so the empty-map fallback isn't
      // silent. NOT cached — next poll retries; the trace then shows the
      // retry, too. Without this the user sees carrier codes instead of
      // names with no log entry explaining why.
      const msg = err instanceof Error ? err.message : String(err);
      this.log?.debug(`carriers: fetch failed (kept empty, will retry): ${msg}`);
      // Return empty map but don't cache it — allow retry next time
      return {};
    }
  }

  /**
   * Resolve a carrier code to a display name.
   *
   * @param carrierCode The carrier code from API
   */
  async getCarrierName(carrierCode: unknown): Promise<string> {
    // API-drift guard: non-string codes fall back to "UNKNOWN"
    if (typeof carrierCode !== "string" || carrierCode.length === 0) {
      // v0.4.3 (D4): trace non-string code drift. Helps diagnose "all my
      // packages show UNKNOWN carrier" reports.
      this.log?.debug(`getCarrierName: non-string code (got ${typeof carrierCode}), returning UNKNOWN`);
      return "UNKNOWN";
    }
    const carriers = await this.getCarrierNames();
    const mapped = carriers[carrierCode];
    return typeof mapped === "string" && mapped.length > 0 ? mapped : carrierCode.toUpperCase();
  }

  /** Test if the API key is valid */
  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      await this.getDeliveries("active");
      return { success: true, message: "Connection successful" };
    } catch (err) {
      const error = err as Error & { code?: string };
      if (error.code === "INVALID_API_KEY") {
        return { success: false, message: "Invalid API key" };
      }
      return { success: false, message: error.message };
    }
  }

  /**
   * Execute an HTTP request against the parcel.app API.
   *
   * @param method HTTP method
   * @param path API path
   * @param authenticated Whether to send the API key
   * @param body Optional request body
   */
  private request<T>(method: string, path: string, authenticated: boolean, body?: unknown): Promise<T> {
    // v0.4.3 (A0): start timestamp for elapsed-ms in the success/timeout/error
    // log lines. One LOC, no behavior change.
    const startedAt = Date.now();
    // v0.4.3 (A1): trace request entry. ~144 calls/day at the default 10-min
    // poll interval — acceptable at debug.
    this.log?.debug(`HTTP ${method} ${path}`);
    return new Promise((resolve, reject) => {
      // v0.4.2 (E3): URL-shape validation defensive — paths are hardcoded
      // upstream but a future caller could pass garbage; surface a clear
      // error class instead of a TypeError thrown sync from the executor.
      let url: URL;
      try {
        url = new URL(`${this.baseUrl}${path}`);
      } catch {
        // v0.4.3 (A10): trace invalid-URL drift before throwing.
        this.log?.debug(`HTTP invalid URL: ${this.baseUrl}${path}`);
        reject(apiError(`Invalid URL: ${this.baseUrl}${path}`, "INVALID_URL"));
        return;
      }

      const headers: Record<string, string> = {};
      if (authenticated) {
        headers["api-key"] = this.apiKey;
      }
      if (body) {
        headers["Content-Type"] = "application/json";
      }

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method,
        headers,
        timeout: REQUEST_TIMEOUT,
      };

      // v0.4.2 (P1): per-request AbortController. `cancelAll()` (called
      // from `onUnload`) aborts everything pending without waiting for
      // the configured timeout.
      const ctrl = new AbortController();
      this.inflight.add(ctrl);
      const cleanup = (): void => {
        this.inflight.delete(ctrl);
      };

      // Pick transport from the URL protocol so tests can run the real
      // request() against a local http mock server; production is always https.
      const transportRequest: (
        opts: https.RequestOptions,
        callback: (res: http.IncomingMessage) => void,
      ) => http.ClientRequest = url.protocol === "http:" ? http.request : https.request;

      const req = transportRequest(options, res => {
        const chunks: Buffer[] = [];
        let bodyBytes = 0;
        let oversized = false;

        res.on("error", err => {
          cleanup();
          reject(err);
        });
        res.on("data", (chunk: Buffer) => {
          if (oversized) {
            return;
          }
          bodyBytes += chunk.length;
          // v0.4.2 (P9): drop oversized responses so a compromised or
          // misconfigured endpoint can't OOM the adapter. Reject with the
          // stable BODY_TOO_LARGE code here, then destroy WITHOUT an error so
          // req.on("error") doesn't fire a second, codeless rejection (the
          // earlier `req.destroy(Error)` preempted the end-handler's code).
          if (bodyBytes > MAX_BODY_BYTES) {
            oversized = true;
            // v0.4.3 (A9): trace the oversize-drop before destroying.
            this.log?.debug(`HTTP body oversized ${path}: dropping at ${bodyBytes}B`);
            cleanup();
            reject(apiError("Response body too large", "BODY_TOO_LARGE"));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (oversized) {
            return; // already cleaned up + rejected in the data handler
          }
          cleanup();
          const raw = Buffer.concat(chunks).toString("utf-8");

          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            if (res.statusCode === 429) {
              // v0.4.2 (P6): clamp Retry-After parser. Bogus values (0,
              // negative, NaN) used to fall through `>0` and default to
              // 5 min — keep that, but also reject infinity/extreme.
              const retryAfter = parseInt(res.headers["retry-after"] || "", 10);
              const retryAfterSeconds =
                Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(24 * 3600, retryAfter) : 5 * 60;
              // v0.4.3 (A4): trace 429 with the parsed retry-after.
              this.log?.debug(`HTTP 429 ${path} → retry-after=${retryAfterSeconds}s`);
              reject(apiError("Rate limit exceeded", "RATE_LIMITED", { retryAfterSeconds }));
              return;
            }
            // v0.4.2 (P3): split 401 (invalid key) from 403 (permission /
            // no premium). Adapter treats them differently — INVALID_API_KEY
            // says "fix the key", FORBIDDEN says "fix the account".
            const code =
              res.statusCode === 401 ? "INVALID_API_KEY" : res.statusCode === 403 ? "FORBIDDEN" : "HTTP_ERROR";
            // v0.4.3 (A3): trace 4xx/5xx with body-snippet for diagnosis.
            this.log?.debug(`HTTP ${method} ${path} → ${res.statusCode} ${code} (body=${raw.substring(0, 200)})`);
            reject(apiError(`HTTP ${res.statusCode}: ${res.statusMessage}`, code));
            return;
          }

          try {
            const parsed = JSON.parse(raw) as T;
            // v0.4.3 (A2): trace successful response with elapsed-ms + bytes.
            this.log?.debug(`HTTP ${method} ${path} → ${res.statusCode} (${Date.now() - startedAt}ms, ${bodyBytes}B)`);
            resolve(parsed);
          } catch {
            // v0.4.3 (A8): trace JSON parse-fail with snippet.
            this.log?.debug(`HTTP JSON parse fail ${path}: ${raw.substring(0, 200)}`);
            reject(new Error(`JSON parse error: ${raw.substring(0, 200)}`));
          }
        });
      });

      ctrl.signal.addEventListener("abort", () => {
        // v0.4.3: A6 deliberately omitted — `req.destroy(Error)` propagates
        // through `req.on("error")` below where A7 already logs it.
        req.destroy(new Error("Request aborted"));
      });

      req.on("timeout", () => {
        req.destroy();
        cleanup();
        // v0.4.3 (A5): trace timeout with elapsed-ms.
        this.log?.debug(`HTTP timeout ${method} ${path} (${Date.now() - startedAt}ms)`);
        reject(new Error("Request timeout"));
      });

      req.on("error", err => {
        cleanup();
        // v0.4.3 (A7): trace network / abort / TLS / DNS errors with elapsed.
        // Also catches the abort case (req.destroy(Error("Request aborted")))
        // — A6 deliberately not emitted to avoid double-log.
        this.log?.debug(`HTTP error ${method} ${path} (${Date.now() - startedAt}ms): ${err.message}`);
        reject(err);
      });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }
}
