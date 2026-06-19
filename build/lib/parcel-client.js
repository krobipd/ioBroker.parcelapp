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
  ParcelClient: () => ParcelClient
});
module.exports = __toCommonJS(parcel_client_exports);
var http = __toESM(require("node:http"));
var https = __toESM(require("node:https"));
var import_coerce = require("./coerce");
const API_BASE = "https://api.parcel.app/external";
const REQUEST_TIMEOUT = 15e3;
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
   * of the static 447-entry file (and a persistently failing endpoint was
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
   * v0.4.2 (P1): abort every in-flight HTTPS request. Idempotent.
   */
  cancelAll() {
    var _a;
    (_a = this.log) == null ? void 0 : _a.debug(`cancelAll: aborting ${this.inflight.size} inflight requests`);
    for (const ctrl of this.inflight) {
      ctrl.abort();
    }
  }
  /**
   * Fetch deliveries from parcel.app.
   *
   * @param filterMode Filter active or recent deliveries
   */
  async getDeliveries(filterMode = "active") {
    var _a, _b;
    const response = await this.request("GET", `/deliveries/?filter_mode=${filterMode}`, true);
    if (!response || typeof response !== "object") {
      (_a = this.log) == null ? void 0 : _a.debug(`API drift: malformed response (got ${typeof response})`);
      throw apiError("API error: malformed response", "API_ERROR");
    }
    if (!(0, import_coerce.isTrueish)(response.success)) {
      const rawMsg = typeof response.error_message === "string" ? response.error_message : "";
      (_b = this.log) == null ? void 0 : _b.debug(`API drift: success=false, msg='${rawMsg}'`);
      throw apiError(`API error: ${rawMsg || "UNKNOWN"}`, "API_ERROR");
    }
    return Array.isArray(response.deliveries) ? response.deliveries : [];
  }
  /**
   * Add a new delivery to parcel.app.
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
  /** One actual carrier-list fetch. Failure → empty map, NOT cached (retry next poll). */
  async fetchCarrierNames() {
    var _a, _b, _c;
    try {
      const raw = await this.request("GET", "/supported_carriers.json", false);
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        this.carrierCache = raw;
        (_a = this.log) == null ? void 0 : _a.debug(`carriers: fetched ${Object.keys(this.carrierCache).length} entries`);
        return this.carrierCache;
      }
      (_b = this.log) == null ? void 0 : _b.debug(
        `carriers: drift (got ${Array.isArray(raw) ? "array" : typeof raw}, expected object), kept empty`
      );
      return {};
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      (_c = this.log) == null ? void 0 : _c.debug(`carriers: fetch failed (kept empty, will retry): ${msg}`);
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
  /** Test if the API key is valid */
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
      var _a2;
      let url;
      try {
        url = new URL(`${this.baseUrl}${path}`);
      } catch {
        (_a2 = this.log) == null ? void 0 : _a2.debug(`HTTP invalid URL: ${this.baseUrl}${path}`);
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
      const cleanup = () => {
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
          var _a3, _b, _c, _d;
          if (oversized) {
            return;
          }
          cleanup();
          const raw = Buffer.concat(chunks).toString("utf-8");
          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            if (res.statusCode === 429) {
              const retryAfter = parseInt(res.headers["retry-after"] || "", 10);
              const retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(24 * 3600, retryAfter) : 5 * 60;
              (_a3 = this.log) == null ? void 0 : _a3.debug(`HTTP 429 ${path} \u2192 retry-after=${retryAfterSeconds}s`);
              reject(apiError("Rate limit exceeded", "RATE_LIMITED", { retryAfterSeconds }));
              return;
            }
            const code = res.statusCode === 401 ? "INVALID_API_KEY" : res.statusCode === 403 ? "FORBIDDEN" : "HTTP_ERROR";
            (_b = this.log) == null ? void 0 : _b.debug(`HTTP ${method} ${path} \u2192 ${res.statusCode} ${code} (body=${raw.substring(0, 200)})`);
            reject(apiError(`HTTP ${res.statusCode}: ${res.statusMessage}`, code));
            return;
          }
          try {
            const parsed = JSON.parse(raw);
            (_c = this.log) == null ? void 0 : _c.debug(`HTTP ${method} ${path} \u2192 ${res.statusCode} (${Date.now() - startedAt}ms, ${bodyBytes}B)`);
            resolve(parsed);
          } catch {
            (_d = this.log) == null ? void 0 : _d.debug(`HTTP JSON parse fail ${path}: ${raw.substring(0, 200)}`);
            reject(new Error(`JSON parse error: ${raw.substring(0, 200)}`));
          }
        });
      });
      ctrl.signal.addEventListener("abort", () => {
        req.destroy(new Error("Request aborted"));
      });
      req.on("timeout", () => {
        var _a3;
        req.destroy();
        cleanup();
        (_a3 = this.log) == null ? void 0 : _a3.debug(`HTTP timeout ${method} ${path} (${Date.now() - startedAt}ms)`);
        reject(new Error("Request timeout"));
      });
      req.on("error", (err) => {
        var _a3;
        cleanup();
        (_a3 = this.log) == null ? void 0 : _a3.debug(`HTTP error ${method} ${path} (${Date.now() - startedAt}ms): ${err.message}`);
        reject(err);
      });
      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ParcelClient
});
//# sourceMappingURL=parcel-client.js.map
