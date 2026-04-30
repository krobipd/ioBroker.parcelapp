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
var https = __toESM(require("node:https"));
const API_BASE = "https://api.parcel.app/external";
const REQUEST_TIMEOUT = 15e3;
function isTrueish(v) {
  if (typeof v === "boolean") {
    return v;
  }
  if (typeof v === "number") {
    return v === 1;
  }
  if (typeof v === "string") {
    const s = v.toLowerCase();
    return s === "true" || s === "1";
  }
  return false;
}
class ParcelClient {
  apiKey;
  carrierCache = null;
  /** @param apiKey The parcel.app API key */
  constructor(apiKey) {
    this.apiKey = apiKey;
  }
  /**
   * Fetch deliveries from parcel.app.
   *
   * @param filterMode Filter active or recent deliveries
   */
  async getDeliveries(filterMode = "active") {
    const response = await this.request("GET", `/deliveries/?filter_mode=${filterMode}`, true);
    if (!response || typeof response !== "object") {
      const err = new Error("API error: malformed response");
      err.code = "API_ERROR";
      throw err;
    }
    if (!isTrueish(response.success)) {
      const rawCode = typeof response.error_code === "string" ? response.error_code : "";
      const rawMsg = typeof response.error_message === "string" ? response.error_message : "";
      const code = rawCode || rawMsg || "UNKNOWN";
      const err = new Error(`API error: ${rawMsg || code}`);
      err.code = rawCode === "INVALID_API_KEY" ? "INVALID_API_KEY" : "API_ERROR";
      throw err;
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
  /** Get carrier names (cached after first call) */
  async getCarrierNames() {
    if (this.carrierCache) {
      return this.carrierCache;
    }
    try {
      const raw = await this.request("GET", "/supported_carriers.json", false);
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        this.carrierCache = raw;
      } else {
        return {};
      }
    } catch {
      return {};
    }
    return this.carrierCache;
  }
  /**
   * Resolve a carrier code to a display name.
   *
   * @param carrierCode The carrier code from API
   */
  async getCarrierName(carrierCode) {
    if (typeof carrierCode !== "string" || carrierCode.length === 0) {
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
    return new Promise((resolve, reject) => {
      const url = new URL(`${API_BASE}${path}`);
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
      const req = https.request(options, (res) => {
        const chunks = [];
        res.on("error", (err) => reject(err));
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            if (res.statusCode === 429) {
              const retryAfter = parseInt(res.headers["retry-after"] || "", 10);
              const err2 = new Error("Rate limit exceeded");
              err2.code = "RATE_LIMITED";
              err2.retryAfterSeconds = retryAfter > 0 ? retryAfter : 5 * 60;
              reject(err2);
              return;
            }
            const err = new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`);
            err.code = res.statusCode === 401 || res.statusCode === 403 ? "INVALID_API_KEY" : "HTTP_ERROR";
            reject(err);
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch {
            reject(new Error(`JSON parse error: ${raw.substring(0, 200)}`));
          }
        });
      });
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timeout"));
      });
      req.on("error", (err) => reject(err));
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
