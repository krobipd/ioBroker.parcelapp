import * as http from "node:http";
import * as https from "node:https";
import { errText, isTrueish, LOG_SNIPPET_LEN, oneLine } from "./coerce";
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
/**
 * v0.14.0 (audit L8): the floor of the cooldown. A server asking for a few seconds would otherwise
 * let the next poll run into the same limit; the adapter used to apply this floor a second time in
 * main.ts — the clamp now lives here, once.
 */
export const RETRY_AFTER_MIN_SEC = 60;

/**
 * v0.13.0: the one explanation for HTTP 403 — parcel.app answers Forbidden when
 * the account has no active Premium subscription or the key was revoked.
 * Shared by the poll error path (main.ts) and the admin connection test, so
 * both tell the user the same thing.
 */
export const FORBIDDEN_HINT =
  "parcel.app returned 403 Forbidden — your account may not have an active Premium subscription, or the API key was revoked. Check your account on parcelapp.net.";

/**
 * v0.4.3: optional logger injected by the adapter so the HTTPS client can
 * trace its own request/response lifecycle. When omitted (e.g. in tests),
 * every `this.log?.debug(...)` call is a no-op — keeps the bare-`apiKey`
 * constructor signature backward-compatible.
 */
export interface ParcelClientLogger {
  /** Adapter debug log. Called per request/response outcome (drift, status, parse, oversize) — low-frequency tracing. */
  debug(message: string): void;
  /**
   * v0.13.0: adapter warn log, optional. Used exactly once per process when the
   * carrier list arrives in a shape the client cannot read — the one drift that
   * silently degrades a visible feature (every package shows its carrier code).
   */
  warn?(message: string): void;
}

/**
 * Timeout overrides. Production never passes these — the defaults
 * ({@link REQUEST_TIMEOUT} / {@link REQUEST_DEADLINE_MS}) apply. Same seam idea
 * as the `baseUrl` parameter: without it the two watchdogs below could only be
 * exercised by a test that waits 15 respectively 60 seconds, so they stayed
 * untested — and an untested watchdog is exactly the one that silently stops
 * working (test audit 2026-08-22, finding C14).
 */
export interface ParcelClientTimeouts {
  /** Socket idle timeout (ms). */
  idleMs?: number;
  /** Hard per-request deadline (ms). */
  deadlineMs?: number;
}
/**
 * v0.14.0 (audit L10): the timers the client may use. The adapter passes its own
 * `this.setTimeout`/`this.clearTimeout` (fleet rule: never a native timer in adapter code — the
 * adapter's timers are cleared on unload and refused during shutdown); tests pass plain ones.
 * Declared as function-typed properties, not method signatures: the repository checker (S5005)
 * reads `setTimeout(` in a method signature as a bare native timer call.
 */
export interface ParcelClientTimers {
  /** Arm a one-shot timer; the returned handle goes back into `clearTimeout`. */
  setTimeout: (callback: () => void, ms: number) => unknown;
  /** Cancel a timer armed by `setTimeout`; an `undefined` handle is a no-op. */
  clearTimeout: (handle: unknown) => void;
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

/**
 * v0.14.0 (audit B9): the carrier list is re-read once a day. It changes — carriers are added,
 * renamed (Bartolini → BRT) and removed — and the adapter used to keep the first copy for the whole
 * process lifetime.
 */
const CARRIER_LIST_TTL_MS = 24 * 60 * 60_000;
/** After a failed refresh the known names stay, and the next attempt waits this long. */
const CARRIER_LIST_RETRY_MS = 60 * 60_000;

/** HTTP client for the parcel.app API */
export class ParcelClient {
  private apiKey: string;
  private carrierCache: CarrierMap | null = null;
  /** When the cached carrier list was last read successfully (B9). */
  private carrierFetchedAt = 0;
  /** Earliest time of the next refresh attempt after a failed one (B9). */
  private carrierRetryAt = 0;
  /**
   * v0.7.2: in-flight fetch for the carrier list. The per-delivery updates run
   * in parallel (Promise.all) and each resolves carrier names — without this
   * mutex the first poll with N packages fired N identical concurrent fetches
   * of the static carrier-list file (and a persistently failing endpoint was
   * retried N times per poll). Same pattern as beszel's auth mutex (B1).
   */
  private carrierFetchInFlight: Promise<CarrierMap> | null = null;
  /** v0.13.0: the unreadable-carrier-list warning is logged once per process; repeats go to debug. */
  private carrierDriftWarned = false;
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
  /** Socket idle timeout in ms — same seam idea as {@link baseUrl}, see {@link ParcelClientTimeouts}. */
  private readonly idleTimeoutMs: number;
  /** Hard per-request deadline in ms — see {@link ParcelClientTimeouts}. */
  private readonly deadlineMs: number;
  /** Timer seam for the per-request deadline — see {@link ParcelClientTimers}. */
  private readonly timers: ParcelClientTimers;

  /**
   * @param apiKey The parcel.app API key
   * @param timers The adapter's timers (v0.14.0 — the deadline is an adapter timer, never a native one)
   * @param log Optional adapter logger for HTTPS-layer trace (v0.4.3)
   * @param baseUrl API base URL — defaults to the production endpoint; overridden in tests
   * @param timeouts Timeout overrides — production always uses the defaults
   */
  constructor(
    apiKey: string,
    timers: ParcelClientTimers,
    log?: ParcelClientLogger,
    baseUrl: string = API_BASE,
    timeouts: ParcelClientTimeouts = {},
  ) {
    this.apiKey = apiKey;
    this.timers = timers;
    this.log = log;
    this.baseUrl = baseUrl;
    this.idleTimeoutMs = timeouts.idleMs ?? REQUEST_TIMEOUT;
    this.deadlineMs = timeouts.deadlineMs ?? REQUEST_DEADLINE_MS;
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
        typeof response.error_message === "string" ? oneLine(response.error_message).slice(0, LOG_SNIPPET_LEN) : "";
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
    // Same drift class one level down: an entry that is not an object (null,
    // number, string, nested array) would blow up deep inside the poll — a
    // TypeError from parseStatus reading `.status_code`, classified UNKNOWN and
    // logged as "Poll failed: Cannot read properties of null". Fail the same way
    // the wrong-typed list does: a coded API error, existing states kept stale.
    const entries: unknown[] = response.deliveries;
    const bad = entries.findIndex(d => d === null || typeof d !== "object" || Array.isArray(d));
    if (bad !== -1) {
      this.log?.debug(
        `API drift: deliveries[${bad}] is not an object (got ${Array.isArray(entries[bad]) ? "array" : typeof entries[bad]})`,
      );
      throw apiError("API error: malformed delivery entry", "API_ERROR");
    }
    return response.deliveries;
  }

  /**
   * Add a new delivery to parcel.app.
   *
   * Error style: transport/HTTP failures reject with {@link ApiError}; a 2xx
   * body is returned as-is once it is a plain object (its fields are not
   * validated) — `success: false` is passed through unchanged because sendTo
   * callers receive this object verbatim.
   *
   * @param delivery The delivery to add
   */
  async addDelivery(delivery: AddDeliveryRequest): Promise<AddDeliveryResponse> {
    const response = await this.request<unknown>("POST", "/add-delivery/", true, delivery);
    // API-drift guard: the body goes to the sendTo caller verbatim and the
    // adapter reads `.success` from it — a null/array/primitive body used to
    // surface as a TypeError ("Cannot read properties of null") instead of a
    // clear API error.
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      this.log?.debug(
        `API drift: malformed add-delivery response (got ${Array.isArray(response) ? "array" : typeof response})`,
      );
      throw apiError("API error: malformed response", "API_ERROR");
    }
    return response as AddDeliveryResponse;
  }

  /**
   * Get carrier names — cached for a day (B9); concurrent callers share one fetch.
   *
   * @returns code → display name
   */
  async getCarrierNames(): Promise<CarrierMap> {
    const now = Date.now();
    if (this.carrierCache && (now - this.carrierFetchedAt < CARRIER_LIST_TTL_MS || now < this.carrierRetryAt)) {
      return this.carrierCache;
    }
    // v0.7.2: share one in-flight fetch between the parallel per-delivery
    // updates instead of firing N identical requests on the first poll.
    if (!this.carrierFetchInFlight) {
      this.carrierFetchInFlight = this.refreshCarrierNames().finally(() => {
        this.carrierFetchInFlight = null;
      });
    }
    return this.carrierFetchInFlight;
  }

  /**
   * v0.14.0 (audit B9): fetch the list and MERGE it into the cache — a code parcel.app dropped from
   * the file keeps the name it had (a package added under it still exists). A failed refresh keeps
   * the known names and waits an hour; without any cache the failure returns an empty map and the
   * next call tries again, as before.
   *
   * @returns the merged map, or the old/empty one after a failure
   */
  private async refreshCarrierNames(): Promise<CarrierMap> {
    const fresh = await this.fetchCarrierNames();
    if (fresh === null) {
      if (this.carrierCache) {
        this.carrierRetryAt = Date.now() + CARRIER_LIST_RETRY_MS;
        this.log?.debug("carriers: refresh failed, keeping the known names — next attempt in an hour");
        return this.carrierCache;
      }
      return {};
    }
    this.carrierCache = { ...(this.carrierCache ?? {}), ...fresh };
    this.carrierFetchedAt = Date.now();
    return this.carrierCache;
  }

  /**
   * One actual carrier-list fetch. Failure → null, and the caller decides (see
   * `refreshCarrierNames`). Without a cache the next update batch retries (the
   * mutex above only dedupes CONCURRENT callers, so a poll with several 25er
   * batches may retry once per batch; the endpoint is a static,
   * unauthenticated file without a rate limit).
   *
   * @returns the names read from the file, or null
   */
  private async fetchCarrierNames(): Promise<CarrierMap | null> {
    try {
      const raw = await this.request<unknown>("GET", "/supported_carriers.json", false);
      // API-drift guard: must be a plain object (not null, array, or primitive)
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        // v0.13.0: parcel.app changed the file from `{ code: "Name" }` to
        // `{ code: { name: "Name", extra_required?: number, name_variations?: {…} } }`
        // (measured 2026-09-15, 304 entries, every value an object). The v0.9.0
        // string-only filter then kept nothing — and cached the empty map for the
        // process lifetime, so every package showed its carrier CODE. Both shapes
        // are read now; anything else is dropped, so the cache stays honestly typed.
        const clean: CarrierMap = {};
        for (const [code, entry] of Object.entries(raw)) {
          const name = ParcelClient.carrierEntryName(entry);
          if (name !== undefined) {
            clean[code] = name;
          }
        }
        const count = Object.keys(clean).length;
        if (count === 0) {
          // No usable entry at all — the file is not empty in reality (304 carriers),
          // so this is the format drift above happening again. NOT cached: the
          // next poll retries (the file is public and not rate-limited). Warned
          // once per process because the visible effect is a degraded feature,
          // not a crash; repeats stay at debug (same pattern as the 403 hint, M3).
          const line =
            "carrier names unavailable: supported_carriers.json arrived in an unexpected format — packages show carrier codes until the next poll succeeds";
          if (this.carrierDriftWarned || !this.log?.warn) {
            this.log?.debug(line);
          } else {
            this.carrierDriftWarned = true;
            this.log.warn(line);
          }
          return null;
        }
        // v0.4.3 (D1): trace the cache fill so a successful read is visible in the
        // debug log (once per adapter start, then once a day).
        this.log?.debug(`carriers: fetched ${count} entries`);
        return clean;
      }
      // v0.4.3 (D3): non-object drift — supported_carriers.json returned
      // something that isn't an object. Empty map is returned, NOT cached.
      this.log?.debug(
        `carriers: drift (got ${Array.isArray(raw) ? "array" : typeof raw}, expected object), not cached`,
      );
      return null;
    } catch (err) {
      // v0.4.3 (D2): trace the fetch-fail so the empty-map fallback isn't
      // silent. NOT cached — next poll retries; the trace then shows the
      // retry, too. Without this the user sees carrier codes instead of
      // names with no log entry explaining why.
      this.log?.debug(`carriers: fetch failed (not cached, will retry): ${errText(err)}`);
      return null;
    }
  }

  /**
   * The display name of one `supported_carriers.json` entry, or `undefined`
   * when the entry carries none. Accepts the current object form
   * (`{ name: "DHL Express", … }`) and the pre-2026 plain string, so a
   * roll-back on parcel.app's side does not kill the names a second time.
   *
   * @param entry One value of the carrier map, untrusted.
   */
  private static carrierEntryName(entry: unknown): string | undefined {
    if (typeof entry === "string") {
      return entry.length > 0 ? entry : undefined;
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const name = (entry as { name?: unknown }).name;
      if (typeof name === "string" && name.length > 0) {
        return name;
      }
    }
    return undefined;
  }

  /**
   * Resolve a carrier code to a display name.
   *
   * @param carrierCode The carrier code from API
   */
  async getCarrierName(carrierCode: unknown): Promise<string> {
    // API-drift guard: non-string codes fall back to "UNKNOWN"
    if (typeof carrierCode !== "string" || carrierCode.length === 0) {
      // v0.4.3 (D4): trace non-string code drift. "UNKNOWN" is for a missing or
      // non-string CODE; a code whose name is unknown falls back to the code in
      // upper case below. (A report of "every package shows its code" is the
      // other defect: the carrier list arriving in a shape the client cannot
      // read — v0.13.0/B1, warned once per process from `fetchCarrierNames`.)
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
      const code = err instanceof Error && "code" in err ? err.code : undefined;
      if (code === "INVALID_API_KEY") {
        return { success: false, message: "Invalid API key" };
      }
      if (code === "FORBIDDEN") {
        // v0.13.0: the poll path has explained 403 since v0.4.2; the admin's
        // Test Connection button only said "HTTP 403: Forbidden".
        return { success: false, message: FORBIDDEN_HINT };
      }
      return { success: false, message: errText(err) };
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

      // v0.14.0 (audit X3): serialize ONCE, before anything is registered — a body that cannot be
      // stringified (circular) fails here without stranding a controller in `inflight`, and the
      // byte length goes out as Content-Length instead of a chunked POST.
      let payload: string | undefined;
      if (body !== undefined) {
        try {
          payload = JSON.stringify(body);
        } catch (err) {
          reject(apiError(`Request write failed: ${errText(err)}`, "API_ERROR"));
          return;
        }
      }

      const headers: Record<string, string> = {};
      if (authenticated) {
        headers["api-key"] = this.apiKey;
      }
      if (payload !== undefined) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = String(Buffer.byteLength(payload));
      }

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method,
        headers,
        timeout: this.idleTimeoutMs,
      };

      // v0.4.2 (P1): per-request AbortController. `cancelAll()` (called
      // from `onUnload`) aborts everything pending without waiting for
      // the configured timeout.
      const ctrl = new AbortController();
      this.inflight.add(ctrl);
      // Every terminal path runs cleanup(): the controller leaves `inflight` and the deadline timer
      // is cancelled (v0.14.0 — the former platform timer lingered for the full deadline).
      // A holder, not a `let`: the timer is armed further down, once `req` exists.
      const deadline: { handle?: unknown } = {};
      const cleanup = (): void => {
        this.inflight.delete(ctrl);
        this.timers.clearTimeout(deadline.handle);
      };

      // Pick transport from the URL protocol so tests can run the real
      // request() against a local http mock server; production is always https.
      const transportRequest: (
        opts: https.RequestOptions,
        callback: (res: http.IncomingMessage) => void,
      ) => http.ClientRequest = url.protocol === "http:" ? http.request : https.request;

      // `req` is assigned in the try below (a synchronous throw from the transport must reach
      // cleanup); the response handler only ever runs after that assignment.
      let req: http.ClientRequest;
      const onResponse = (res: http.IncomingMessage): void => {
        const chunks: Buffer[] = [];
        let bodyBytes = 0;
        let oversized = false;

        res.on("error", err => {
          cleanup();
          reject(err);
        });
        res.on("data", (chunk: Buffer) => {
          // Not covered by a test on purpose: this branch only runs for a chunk
          // that was already buffered when `req.destroy()` below fired, i.e. a
          // delivery race no test can trigger deterministically. A test that
          // hits it "usually" would be exactly the kind of flaky check the
          // 2026-08-22 audit removed elsewhere.
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
            // v0.13.0: parcel.app puts the reason into the body on 400/401/403 too
            // (`{"success":false,"error_message":"…"}`, measured 2026-09-15). Until
            // now only the HTTP reason phrase reached the user — a script author
            // with a wrong carrier code saw "HTTP 400: Bad Request" and nothing else.
            const httpError = ParcelClient.mapHttpStatusError(
              res.statusCode,
              res.statusMessage,
              res.headers["retry-after"],
              ParcelClient.errorMessageOf(raw),
            );
            // v0.4.3 (A3/A4): trace 4xx/5xx with code, retry-after and body-snippet.
            this.log?.debug(
              `HTTP ${method} ${path} → ${res.statusCode} ${httpError.code}` +
                `${httpError.retryAfterSeconds !== undefined ? ` retry-after=${httpError.retryAfterSeconds}s` : ""}` +
                ` (body=${oneLine(raw.substring(0, LOG_SNIPPET_LEN))})`,
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
            this.log?.debug(`HTTP JSON parse fail ${path}: ${oneLine(raw.substring(0, LOG_SNIPPET_LEN))}`);
            // v0.9.0 (S1): keep the raw body OUT of the Error message — it
            // bubbles to a poll error-log; a malformed PII-bearing body must
            // not reach error level. The snippet stays in the debug line above.
            reject(apiError(`JSON parse error (${raw.length} bytes)`, "PARSE_ERROR"));
          }
        });
      };

      // v0.14.0 (audit L6): the transport throws SYNCHRONOUSLY for a header it cannot send — an
      // API key with an invisible character copied along (`"key\u200B".trim()` keeps it). Before,
      // the throw left the controller in `inflight` for good and reached the log as a bare
      // "Invalid character in header content" without naming the key.
      try {
        req = transportRequest(options, onResponse);
      } catch (err) {
        cleanup();
        const code = err instanceof Error && "code" in err ? err.code : undefined;
        this.log?.debug(`HTTP ${method} ${path} could not be sent: ${errText(err)}`);
        reject(
          code === "ERR_INVALID_CHAR"
            ? apiError(
                "API key contains characters that cannot be sent — re-enter it without spaces or invisible characters",
                "INVALID_API_KEY",
              )
            : apiError(`Request could not be sent: ${errText(err)}`, "API_ERROR"),
        );
        return;
      }

      // v0.10.0 (M4) / v0.14.0 (audit L10): the hard deadline — destroying with a TIMEOUT-coded
      // ApiError routes through req.on("error") below, which rejects and cleans up, so a trickle
      // response (a byte every few seconds) can no longer pin the poll loop. It is an ADAPTER timer
      // (fleet rule), cancelled by cleanup() the moment the request settles.
      deadline.handle = this.timers.setTimeout(() => {
        this.log?.debug(`HTTP deadline ${method} ${path} (${Date.now() - startedAt}ms > ${this.deadlineMs}ms)`);
        req.destroy(apiError(`Request deadline exceeded (${this.deadlineMs / 1000}s)`, "TIMEOUT"));
      }, this.deadlineMs);

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
        this.log?.debug(`HTTP error ${method} ${path} (${Date.now() - startedAt}ms): ${errText(err)}`);
        reject(err);
      });

      // v0.10.0 (I8): a synchronous throw from stringify/write/end (circular
      // body, stream state) must not strand the AbortController in `inflight`
      // — cancelAll's invariant is "inflight mirrors live requests exactly".
      try {
        if (payload !== undefined) {
          req.write(payload);
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
   * @param detail parcel.app's own `error_message` from the body, when it sent one
   */
  private static mapHttpStatusError(
    statusCode: number,
    statusMessage: string | undefined,
    retryAfterHeader: string | undefined,
    detail?: string,
  ): ApiError {
    if (statusCode === 429) {
      return apiError("Rate limit exceeded", "RATE_LIMITED", {
        retryAfterSeconds: ParcelClient.parseRetryAfter(retryAfterHeader),
      });
    }
    // v0.4.2 (P3): split 401 (invalid key) from 403 (permission / no premium).
    // Adapter treats them differently — INVALID_API_KEY says "fix the key",
    // FORBIDDEN says "fix the account".
    const code: ApiErrorCode = statusCode === 401 ? "INVALID_API_KEY" : statusCode === 403 ? "FORBIDDEN" : "HTTP_ERROR";
    // The body's own reason beats the generic reason phrase; the codes above stay
    // the adapter's classification either way.
    // v0.14.0 (audit X1): an empty or missing reason phrase used to read "HTTP 502: " / "…: undefined".
    return apiError(
      `HTTP ${statusCode}: ${detail ?? (statusMessage || http.STATUS_CODES[statusCode] || "unknown status")}`,
      code,
    );
  }

  /**
   * The cooldown a 429 asks for, in seconds. RFC 9110 §10.2.3 allows delay-seconds OR an
   * HTTP-date; both are read (v0.14.0, audit L8 — a date used to fall back to the default).
   * Anything unusable (missing, zero, negative, garbage, a date in the past) takes
   * {@link RETRY_AFTER_DEFAULT_SEC}; a usable value is clamped to
   * [{@link RETRY_AFTER_MIN_SEC}, {@link RETRY_AFTER_MAX_SEC}] — the one place that clamp lives.
   *
   * @param header Raw Retry-After header value
   * @param nowMs Reference time for an HTTP-date (tests pass a fixed one)
   */
  static parseRetryAfter(header: string | undefined, nowMs: number = Date.now()): number {
    const raw = (header ?? "").trim();
    let seconds = NaN;
    if (/^\d+$/.test(raw)) {
      seconds = Number(raw);
    } else if (raw.length > 0) {
      const at = Date.parse(raw);
      if (Number.isFinite(at)) {
        seconds = Math.ceil((at - nowMs) / 1000);
      }
    }
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return RETRY_AFTER_DEFAULT_SEC;
    }
    return Math.min(RETRY_AFTER_MAX_SEC, Math.max(RETRY_AFTER_MIN_SEC, seconds));
  }

  /**
   * The `error_message` of a parcel.app error body, flattened and capped like
   * every other external text that ends up in a log line — or `undefined` when
   * the body is not that JSON object (proxies answer with HTML, an empty body,
   * or nothing).
   *
   * @param raw The response body as received.
   */
  private static errorMessageOf(raw: string): string | undefined {
    // An empty body fails the parse below like any other non-JSON body.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const message = (parsed as { error_message?: unknown }).error_message;
    if (typeof message !== "string") {
      return undefined;
    }
    const flat = oneLine(message).slice(0, LOG_SNIPPET_LEN);
    return flat.length > 0 ? flat : undefined;
  }
}
