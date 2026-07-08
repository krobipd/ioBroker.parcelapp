import * as http from "node:http";
import * as https from "node:https";
import { errText, isTrueish, oneLine } from "./coerce";
import type {
  ApiError,
  ApiErrorCode,
  ParcelApiResponse,
  ParcelDelivery,
  AddDeliveryRequest,
  AddDeliveryResponse,
  CarrierMap,
} from "./types";

const API_BASE = "https://api.parcel.app/external";
/** Socket IDLE timeout — fires only when the connection goes silent. */
const REQUEST_TIMEOUT = 15_000;
/**
 * Hard per-request deadline. The socket idle timeout above never fires against
 * a trickle response (a byte every few seconds), which would otherwise pin
 * `isPolling` forever and silently stop the poll loop until a restart. This
 * timer caps the TOTAL request duration regardless of socket activity.
 */
const REQUEST_DEADLINE_MS = 60_000;
/** Shared Retry-After clamps (used by the client parser and the adapter cooldown). */
export const RETRY_AFTER_MAX_SEC = 24 * 3600;
export const RETRY_AFTER_DEFAULT_SEC = 5 * 60;
/** Max chars of a response body quoted into a debug log line. */
const BODY_SNIPPET_LEN = 200;

/**
 * v0.4.3: optional logger injected by the adapter so the HTTPS client can
 * trace its own request/response lifecycle. When omitted (e.g. in tests),
 * every `this.log?.debug(...)` call is a no-op — keeps the bare-`apiKey`
 * constructor signature backward-compatible.
 */
export interface ParcelClientLogger {
  /** Adapter debug log. Called per request/response outcome (drift, status, parse, oversize) — low-frequency tracing. */
  debug(message: string): void;
}
/**
 * v0.4.2 (P9): hard cap on response body size. parcel.app deliveries lists
 * are tiny (~1 kB per package, max ~50 packages = 50 kB), so a 1 MiB cap is
 * 20× the realistic max while still defending against a runaway response.
 */
const MAX_BODY_BYTES = 1 << 20; // 1 MiB

/**
 * Build an {@link ApiError} carrying a typed `code` (and optional extra fields
 * such as `retryAfterSeconds`). Centralizes the `new Error(...)` + `err.code`
 * pattern; the `ApiErrorCode` union makes a typo on either side of the
 * client↔adapter contract a compile error.
 *
 * @param message Human-readable error message.
 * @param code Machine-readable error code used by the adapter for classification.
 * @param extra Optional additional own-properties to attach to the error.
 */
function apiError(message: string, code: ApiErrorCode, extra?: Record<string, unknown>): ApiError {
  const err = new Error(message) as ApiError;
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
   * of the static carrier-list file (and a persistently failing endpoint was
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
   * v0.10.0 (L3): once cancelAll ran, the client is terminal — a request
   * STARTED after the abort (e.g. the carrier fetch kicked off by a poll
   * batch that was already past getDeliveries at unload) must not open a
   * fresh HTTPS connection that could outlive js-controller's 4s kill
   * deadline. `request()` rejects immediately when this is set.
   */
  private cancelled = false;

  /**
   * v0.4.2 (P1): abort every in-flight HTTPS request and refuse new ones.
   * Idempotent.
   */
  cancelAll(): void {
    // v0.4.3 (A12): trace the shutdown anchor so the adapter log shows
    // exactly how many HTTPS calls were aborted at unload.
    this.log?.debug(`cancelAll: aborting ${this.inflight.size} inflight requests`);
    this.cancelled = true;
    for (const ctrl of this.inflight) {
      ctrl.abort();
    }
  }

  /**
   * Fetch deliveries from parcel.app.
   *
   * Error style: rejects with a code-bearing {@link ApiError} on every failure
   * (HTTP status, drift, transport) — callers classify via `error.code`.
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
      // v0.10.0 (M6): the external error_message is flattened + capped before it
      // reaches any log sink — it bubbles into the poll error-log via the Error
      // message, and an unsanitized multi-line value would forge log lines.
      const rawMsg =
        typeof response.error_message === "string" ? oneLine(response.error_message).slice(0, BODY_SNIPPET_LEN) : "";
      // v0.4.3 (A11b): trace API-side error before throwing. An invalid key is
      // reported via HTTP 401 (handled in request()), not via a body field —
      // so a `success:false` body is always a generic API_ERROR.
      this.log?.debug(`API drift: success=false, msg='${rawMsg}'`);
      throw apiError(`API error: ${rawMsg || "UNKNOWN"}`, "API_ERROR");
    }

    // API-drift guard. An absent OR null `deliveries` is the API's "no
    // deliveries" shape → [] (zero active packages is the common state; a false
    // throw there would flip the adapter to disconnected on every poll). Only a
    // PRESENT, NON-NULL, wrong-typed value (string/number/object/boolean) is
    // real drift — throw so the poll keeps the existing states stale instead of
    // reading garbage as "zero deliveries" and deleting every package's states.
    if (response.deliveries == null) {
      return [];
    }
    if (!Array.isArray(response.deliveries)) {
      this.log?.debug(`API drift: deliveries not an array (got ${typeof response.deliveries})`);
      throw apiError("API error: deliveries not an array", "API_ERROR");
    }
    return response.deliveries;
  }

  /**
   * Add a new delivery to parcel.app.
   *
   * Error style: transport/HTTP failures reject with {@link ApiError}; a 2xx
   * body is returned RAW and never validated — `success: false` is passed
   * through unchanged because sendTo callers receive this object verbatim.
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

  /**
   * One actual carrier-list fetch. Failure → empty map, NOT cached — retried by
   * the next update batch (the mutex above only dedupes CONCURRENT callers, so
   * a poll with several 25er batches may retry once per batch; the endpoint is
   * a static, unauthenticated file without a rate limit).
   */
  private async fetchCarrierNames(): Promise<CarrierMap> {
    try {
      const raw = await this.request<unknown>("GET", "/supported_carriers.json", false);
      // API-drift guard: must be a plain object (not null, array, or primitive)
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        // v0.9.0 (C6): keep only string-valued entries instead of asserting the
        // whole object is Record<string,string>. A drifted non-string value is
        // dropped here, so the cache is honestly typed (no `as CarrierMap`).
        const clean: CarrierMap = {};
        for (const [code, name] of Object.entries(raw)) {
          if (typeof name === "string") {
            clean[code] = name;
          }
        }
        this.carrierCache = clean;
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
      this.log?.debug(`carriers: fetch failed (kept empty, will retry): ${errText(err)}`);
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

  /**
   * Test if the API key is valid.
   *
   * Error style: never throws — failures are folded into the returned
   * `{ success: false, message }` result object.
   */
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
      // v0.10.0 (L3): terminal after cancelAll — a request started AFTER the
      // shutdown abort must not open a fresh connection.
      if (this.cancelled) {
        this.log?.debug(`HTTP ${method} ${path} refused — client cancelled`);
        reject(apiError("Client cancelled", "ABORTED"));
        return;
      }
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
      // v0.10.0 (M4): hard per-request deadline (armed after `req` exists).
      // Native timer is fine here (library code, no adapter context) — every
      // terminal path runs cleanup(), which clears it.
      let deadlineTimer: NodeJS.Timeout | undefined;
      const cleanup = (): void => {
        this.inflight.delete(ctrl);
        if (deadlineTimer !== undefined) {
          clearTimeout(deadlineTimer);
          deadlineTimer = undefined;
        }
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
          // The MAX_BODY_BYTES cap above bounds `chunks`, so concat stays well
          // under Buffer's max length and toString won't throw here.
          const raw = Buffer.concat(chunks).toString("utf-8");

          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            const httpError = ParcelClient.mapHttpStatusError(
              res.statusCode,
              res.statusMessage,
              res.headers["retry-after"],
            );
            // v0.4.3 (A3/A4): trace 4xx/5xx with code, retry-after and body-snippet.
            this.log?.debug(
              `HTTP ${method} ${path} → ${res.statusCode} ${httpError.code}` +
                `${httpError.retryAfterSeconds !== undefined ? ` retry-after=${httpError.retryAfterSeconds}s` : ""}` +
                ` (body=${oneLine(raw.substring(0, BODY_SNIPPET_LEN))})`,
            );
            reject(httpError);
            return;
          }

          try {
            const parsed = JSON.parse(raw) as T;
            // v0.4.3 (A2): trace successful response with elapsed-ms + bytes.
            this.log?.debug(`HTTP ${method} ${path} → ${res.statusCode} (${Date.now() - startedAt}ms, ${bodyBytes}B)`);
            resolve(parsed);
          } catch {
            // v0.4.3 (A8): trace JSON parse-fail with snippet (debug only).
            this.log?.debug(`HTTP JSON parse fail ${path}: ${oneLine(raw.substring(0, BODY_SNIPPET_LEN))}`);
            // v0.9.0 (S1): keep the raw body OUT of the Error message — it
            // bubbles to a poll error-log; a malformed PII-bearing body must
            // not reach error level. The snippet stays in the debug line above.
            reject(apiError(`JSON parse error (${raw.length} bytes)`, "PARSE_ERROR"));
          }
        });
      });

      // v0.10.0 (M4): arm the hard deadline. Destroying with a TIMEOUT-coded
      // ApiError routes through req.on("error") below, which rejects + cleans
      // up — a trickle response (a byte every few seconds) can no longer pin
      // the poll loop forever.
      deadlineTimer = setTimeout(() => {
        this.log?.debug(`HTTP deadline ${method} ${path} (${Date.now() - startedAt}ms > ${REQUEST_DEADLINE_MS}ms)`);
        req.destroy(apiError(`Request deadline exceeded (${REQUEST_DEADLINE_MS / 1000}s)`, "TIMEOUT"));
      }, REQUEST_DEADLINE_MS);

      ctrl.signal.addEventListener("abort", () => {
        // v0.4.3: A6 deliberately omitted — `req.destroy(Error)` propagates
        // through `req.on("error")` below where A7 already logs it.
        // v0.10.0 (M1): carries the ABORTED code so the adapter routes an
        // expected shutdown-abort to debug instead of an error log line.
        req.destroy(apiError("Request aborted", "ABORTED"));
      });

      req.on("timeout", () => {
        req.destroy();
        cleanup();
        // v0.4.3 (A5): trace timeout with elapsed-ms.
        this.log?.debug(`HTTP timeout ${method} ${path} (${Date.now() - startedAt}ms)`);
        reject(apiError("Request timeout", "TIMEOUT"));
      });

      req.on("error", err => {
        cleanup();
        // v0.4.3 (A7): trace network / abort / TLS / DNS errors with elapsed.
        // Also catches the abort case (req.destroy(ApiError)) — A6 deliberately
        // not emitted to avoid double-log.
        this.log?.debug(`HTTP error ${method} ${path} (${Date.now() - startedAt}ms): ${err.message}`);
        reject(err);
      });

      // v0.10.0 (I8): a synchronous throw from stringify/write/end (circular
      // body, stream state) must not strand the AbortController in `inflight`
      // — cancelAll's invariant is "inflight mirrors live requests exactly".
      try {
        if (body) {
          req.write(JSON.stringify(body));
        }
        req.end();
      } catch (err) {
        cleanup();
        req.destroy();
        reject(apiError(`Request write failed: ${errText(err)}`, "API_ERROR"));
      }
    });
  }

  /**
   * Map a non-2xx HTTP status to its {@link ApiError}. Pure — extracted from
   * the end-handler so the 401/403/429 rules read in isolation (v0.10.0, L17).
   *
   * @param statusCode HTTP status code (non-2xx)
   * @param statusMessage HTTP status message
   * @param retryAfterHeader Raw Retry-After header value (429 only)
   */
  private static mapHttpStatusError(
    statusCode: number,
    statusMessage: string | undefined,
    retryAfterHeader: string | undefined,
  ): ApiError {
    if (statusCode === 429) {
      // v0.4.2 (P6): clamp Retry-After. Bogus values (0, negative, NaN) fall
      // back to the default; extreme values are capped.
      const retryAfter = parseInt(retryAfterHeader || "", 10);
      const retryAfterSeconds =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(RETRY_AFTER_MAX_SEC, retryAfter)
          : RETRY_AFTER_DEFAULT_SEC;
      return apiError("Rate limit exceeded", "RATE_LIMITED", { retryAfterSeconds });
    }
    // v0.4.2 (P3): split 401 (invalid key) from 403 (permission / no premium).
    // Adapter treats them differently — INVALID_API_KEY says "fix the key",
    // FORBIDDEN says "fix the account".
    const code: ApiErrorCode = statusCode === 401 ? "INVALID_API_KEY" : statusCode === 403 ? "FORBIDDEN" : "HTTP_ERROR";
    return apiError(`HTTP ${statusCode}: ${statusMessage}`, code);
  }
}
