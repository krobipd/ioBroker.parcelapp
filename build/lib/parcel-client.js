"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var parcel_client_exports = {};
__export(parcel_client_exports, {
  ParcelClient: () => ParcelClient,
  RETRY_AFTER_DEFAULT_SEC: () => RETRY_AFTER_DEFAULT_SEC,
  RETRY_AFTER_MAX_SEC: () => RETRY_AFTER_MAX_SEC
});
module.exports = __toCommonJS(parcel_client_exports);
var http = __toESM(require("node:http"));
var https = __toESM(require("node:https"));
var import_coerce = require("./coerce");
const API_BASE = "https://api.parcel.app/external";
const REQUEST_TIMEOUT = 15e3;
const REQUEST_DEADLINE_MS = 6e4;
const RETRY_AFTER_MAX_SEC = 24 * 3600;
const RETRY_AFTER_DEFAULT_SEC = 5 * 60;
const BODY_SNIPPET_LEN = 200;
const MAX_BODY_BYTES = 1 << 20;
function apiError(message, code, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) {
    Object.assign(err, extra);
  }
  return err;
}
class ParcelClient {
  apiKey;
  carrierCache = null;
  /**
   * v0.7.2: in-flight fetch for the carrier list. The per-delivery updates run
   * in parallel (Promise.all) and each resolves carrier names — without this
   * mutex the first poll with N packages fired N identical concurrent fetches
   * of the static carrier-list file (and a persistently failing endpoint was
   * retried N times per poll). Same pattern as beszel's auth mutex (B1).
   */
  carrierFetchInFlight = null;
  /**
   * v0.4.2 (P1): per-request AbortController. `cancelAll()` aborts every
   * pending HTTPS request — called from the adapter's `onUnload` so a slow
   * parcel.app endpoint can't keep the adapter alive past js-controller's
   * 4-second kill deadline.
   */
  inflight = /* @__PURE__ */ new Set();
  /** v0.4.3: optional logger for the HTTPS-layer trace. See {@link ParcelClientLogger}. */
  log;
  /** API base URL. Overridable so tests can run the real `request()` against a local mock server. */
  baseUrl;
  /**
   * @param apiKey The parcel.app API key
   * @param log Optional adapter logger for HTTPS-layer trace (v0.4.3)
   * @param baseUrl API base URL — defaults to the production endpoint; overridden in tests
   */
  constructor(apiKey, log, baseUrl = API_BASE) {
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
  cancelled = false;
  /**
   * v0.4.2 (P1): abort every in-flight HTTPS request and refuse new ones.
   * Idempotent.
   */
  cancelAll() {
    var _a;
    (_a = this.log) == null ? void 0 : _a.debug(`cancelAll: aborting ${this.inflight.size} inflight requests`);
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
  async getDeliveries(filterMode = "active") {
    var _a, _b, _c;
    const response = await this.request("GET", `/deliveries/?filter_mode=${filterMode}`, true);
    if (!response || typeof response !== "object") {
      (_a = this.log) == null ? void 0 : _a.debug(`API drift: malformed response (got ${typeof response})`);
      throw apiError("API error: malformed response", "API_ERROR");
    }
    if (!(0, import_coerce.isTrueish)(response.success)) {
      const rawMsg = typeof response.error_message === "string" ? (0, import_coerce.oneLine)(response.error_message).slice(0, BODY_SNIPPET_LEN) : "";
      (_b = this.log) == null ? void 0 : _b.debug(`API drift: success=false, msg='${rawMsg}'`);
      throw apiError(`API error: ${rawMsg || "UNKNOWN"}`, "API_ERROR");
    }
    if (response.deliveries == null) {
      return [];
    }
    if (!Array.isArray(response.deliveries)) {
      (_c = this.log) == null ? void 0 : _c.debug(`API drift: deliveries not an array (got ${typeof response.deliveries})`);
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
  async addDelivery(delivery) {
    return this.request("POST", "/add-delivery/", true, delivery);
  }
  /** Get carrier names (cached after first call; concurrent callers share one fetch) */
  async getCarrierNames() {
    if (this.carrierCache) {
      return this.carrierCache;
    }
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
  async fetchCarrierNames() {
    var _a, _b, _c;
    try {
      const raw = await this.request("GET", "/supported_carriers.json", false);
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const clean = {};
        for (const [code, name] of Object.entries(raw)) {
          if (typeof name === "string") {
            clean[code] = name;
          }
        }
        this.carrierCache = clean;
        (_a = this.log) == null ? void 0 : _a.debug(`carriers: fetched ${Object.keys(this.carrierCache).length} entries`);
        return this.carrierCache;
      }
      (_b = this.log) == null ? void 0 : _b.debug(
        `carriers: drift (got ${Array.isArray(raw) ? "array" : typeof raw}, expected object), kept empty`
      );
      return {};
    } catch (err) {
      (_c = this.log) == null ? void 0 : _c.debug(`carriers: fetch failed (kept empty, will retry): ${(0, import_coerce.errText)(err)}`);
      return {};
    }
  }
  /**
   * Resolve a carrier code to a display name.
   *
   * @param carrierCode The carrier code from API
   */
  async getCarrierName(carrierCode) {
    var _a;
    if (typeof carrierCode !== "string" || carrierCode.length === 0) {
      (_a = this.log) == null ? void 0 : _a.debug(`getCarrierName: non-string code (got ${typeof carrierCode}), returning UNKNOWN`);
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
  async testConnection() {
    try {
      await this.getDeliveries("active");
      return { success: true, message: "Connection successful" };
    } catch (err) {
      const error = err;
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
  request(method, path, authenticated, body) {
    var _a;
    const startedAt = Date.now();
    (_a = this.log) == null ? void 0 : _a.debug(`HTTP ${method} ${path}`);
    return new Promise((resolve, reject) => {
      var _a2, _b;
      if (this.cancelled) {
        (_a2 = this.log) == null ? void 0 : _a2.debug(`HTTP ${method} ${path} refused \u2014 client cancelled`);
        reject(apiError("Client cancelled", "ABORTED"));
        return;
      }
      let url;
      try {
        url = new URL(`${this.baseUrl}${path}`);
      } catch {
        (_b = this.log) == null ? void 0 : _b.debug(`HTTP invalid URL: ${this.baseUrl}${path}`);
        reject(apiError(`Invalid URL: ${this.baseUrl}${path}`, "INVALID_URL"));
        return;
      }
      const headers = {};
      if (authenticated) {
        headers["api-key"] = this.apiKey;
      }
      if (body) {
        headers["Content-Type"] = "application/json";
      }
      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method,
        headers,
        timeout: REQUEST_TIMEOUT
      };
      const ctrl = new AbortController();
      this.inflight.add(ctrl);
      let settled = false;
      const cleanup = () => {
        settled = true;
        this.inflight.delete(ctrl);
      };
      const transportRequest = url.protocol === "http:" ? http.request : https.request;
      const req = transportRequest(options, (res) => {
        const chunks = [];
        let bodyBytes = 0;
        let oversized = false;
        res.on("error", (err) => {
          cleanup();
          reject(err);
        });
        res.on("data", (chunk) => {
          var _a3;
          if (oversized) {
            return;
          }
          bodyBytes += chunk.length;
          if (bodyBytes > MAX_BODY_BYTES) {
            oversized = true;
            (_a3 = this.log) == null ? void 0 : _a3.debug(`HTTP body oversized ${path}: dropping at ${bodyBytes}B`);
            cleanup();
            reject(apiError("Response body too large", "BODY_TOO_LARGE"));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          var _a3, _b2, _c;
          if (oversized) {
            return;
          }
          cleanup();
          const raw = Buffer.concat(chunks).toString("utf-8");
          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            const httpError = ParcelClient.mapHttpStatusError(
              res.statusCode,
              res.statusMessage,
              res.headers["retry-after"]
            );
            (_a3 = this.log) == null ? void 0 : _a3.debug(
              `HTTP ${method} ${path} \u2192 ${res.statusCode} ${httpError.code}${httpError.retryAfterSeconds !== void 0 ? ` retry-after=${httpError.retryAfterSeconds}s` : ""} (body=${(0, import_coerce.oneLine)(raw.substring(0, BODY_SNIPPET_LEN))})`
            );
            reject(httpError);
            return;
          }
          try {
            const parsed = JSON.parse(raw);
            (_b2 = this.log) == null ? void 0 : _b2.debug(`HTTP ${method} ${path} \u2192 ${res.statusCode} (${Date.now() - startedAt}ms, ${bodyBytes}B)`);
            resolve(parsed);
          } catch {
            (_c = this.log) == null ? void 0 : _c.debug(`HTTP JSON parse fail ${path}: ${(0, import_coerce.oneLine)(raw.substring(0, BODY_SNIPPET_LEN))}`);
            reject(apiError(`JSON parse error (${raw.length} bytes)`, "PARSE_ERROR"));
          }
        });
      });
      AbortSignal.timeout(REQUEST_DEADLINE_MS).addEventListener("abort", () => {
        var _a3;
        if (settled) {
          return;
        }
        (_a3 = this.log) == null ? void 0 : _a3.debug(`HTTP deadline ${method} ${path} (${Date.now() - startedAt}ms > ${REQUEST_DEADLINE_MS}ms)`);
        req.destroy(apiError(`Request deadline exceeded (${REQUEST_DEADLINE_MS / 1e3}s)`, "TIMEOUT"));
      });
      ctrl.signal.addEventListener("abort", () => {
        req.destroy(apiError("Request aborted", "ABORTED"));
      });
      req.on("timeout", () => {
        var _a3;
        req.destroy();
        cleanup();
        (_a3 = this.log) == null ? void 0 : _a3.debug(`HTTP timeout ${method} ${path} (${Date.now() - startedAt}ms)`);
        reject(apiError("Request timeout", "TIMEOUT"));
      });
      req.on("error", (err) => {
        var _a3;
        cleanup();
        (_a3 = this.log) == null ? void 0 : _a3.debug(`HTTP error ${method} ${path} (${Date.now() - startedAt}ms): ${err.message}`);
        reject(err);
      });
      try {
        if (body) {
          req.write(JSON.stringify(body));
        }
        req.end();
      } catch (err) {
        cleanup();
        req.destroy();
        reject(apiError(`Request write failed: ${(0, import_coerce.errText)(err)}`, "API_ERROR"));
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
  static mapHttpStatusError(statusCode, statusMessage, retryAfterHeader) {
    if (statusCode === 429) {
      const retryAfter = parseInt(retryAfterHeader || "", 10);
      const retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(RETRY_AFTER_MAX_SEC, retryAfter) : RETRY_AFTER_DEFAULT_SEC;
      return apiError("Rate limit exceeded", "RATE_LIMITED", { retryAfterSeconds });
    }
    const code = statusCode === 401 ? "INVALID_API_KEY" : statusCode === 403 ? "FORBIDDEN" : "HTTP_ERROR";
    return apiError(`HTTP ${statusCode}: ${statusMessage}`, code);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ParcelClient,
  RETRY_AFTER_DEFAULT_SEC,
  RETRY_AFTER_MAX_SEC
});
//# sourceMappingURL=parcel-client.js.map
