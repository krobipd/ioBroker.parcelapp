"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ParcelClient = void 0;
const https = __importStar(require("node:https"));
const API_BASE = "https://api.parcel.app/external";
const REQUEST_TIMEOUT = 15_000;
/**
 * Coerce API-drift boolean responses. parcel.app should return a real boolean
 * for `success`, but the guard accepts common string/number encodings too.
 *
 * @param v Value to interpret as a success flag
 */
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
/** HTTP client for the parcel.app API */
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
        // API-drift guard: response may be null or a non-object
        if (!response || typeof response !== "object") {
            const err = new Error("API error: malformed response");
            err.code = "API_ERROR";
            throw err;
        }
        if (!isTrueish(response.success)) {
            const rawCode = typeof response.error_code === "string" ? response.error_code : "";
            const rawMsg = typeof response.error_message === "string"
                ? response.error_message
                : "";
            const code = rawCode || rawMsg || "UNKNOWN";
            const err = new Error(`API error: ${rawMsg || code}`);
            err.code =
                rawCode === "INVALID_API_KEY" ? "INVALID_API_KEY" : "API_ERROR";
            throw err;
        }
        // API-drift guard: deliveries must be an array
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
            // API-drift guard: must be a plain object (not null, array, or primitive)
            if (raw && typeof raw === "object" && !Array.isArray(raw)) {
                this.carrierCache = raw;
            }
            else {
                return {};
            }
        }
        catch {
            // Return empty map but don't cache it — allow retry next time
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
        // API-drift guard: non-string codes fall back to "UNKNOWN"
        if (typeof carrierCode !== "string" || carrierCode.length === 0) {
            return "UNKNOWN";
        }
        const carriers = await this.getCarrierNames();
        const mapped = carriers[carrierCode];
        return typeof mapped === "string" && mapped.length > 0
            ? mapped
            : carrierCode.toUpperCase();
    }
    /** Test if the API key is valid */
    async testConnection() {
        try {
            await this.getDeliveries("active");
            return { success: true, message: "Connection successful" };
        }
        catch (err) {
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
                timeout: REQUEST_TIMEOUT,
            };
            const req = https.request(options, (res) => {
                const chunks = [];
                res.on("error", (err) => reject(err));
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => {
                    const raw = Buffer.concat(chunks).toString("utf-8");
                    if (res.statusCode &&
                        (res.statusCode < 200 || res.statusCode >= 300)) {
                        if (res.statusCode === 429) {
                            const retryAfter = parseInt(res.headers["retry-after"] || "", 10);
                            const err = new Error("Rate limit exceeded");
                            err.code = "RATE_LIMITED";
                            // Use Retry-After header or default to 5 minutes
                            err.retryAfterSeconds = retryAfter > 0 ? retryAfter : 5 * 60;
                            reject(err);
                            return;
                        }
                        const err = new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`);
                        err.code =
                            res.statusCode === 401 || res.statusCode === 403
                                ? "INVALID_API_KEY"
                                : "HTTP_ERROR";
                        reject(err);
                        return;
                    }
                    try {
                        resolve(JSON.parse(raw));
                    }
                    catch {
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
exports.ParcelClient = ParcelClient;
