import * as https from "node:https";
import { isTrueish } from "./coerce";
import type { ParcelApiResponse, ParcelDelivery, AddDeliveryRequest, AddDeliveryResponse, CarrierMap } from "./types";

const API_BASE = "https://api.parcel.app/external";
const REQUEST_TIMEOUT = 15_000;
/**
 * v0.4.2 (P9): hard cap on response body size. parcel.app deliveries lists
 * are tiny (~1 kB per package, max ~50 packages = 50 kB), so a 1 MiB cap is
 * 20× the realistic max while still defending against a runaway response.
 */
const MAX_BODY_BYTES = 1 << 20; // 1 MiB

/** HTTP client for the parcel.app API */
export class ParcelClient {
  private apiKey: string;
  private carrierCache: CarrierMap | null = null;
  /**
   * v0.4.2 (P1): per-request AbortController. `cancelAll()` aborts every
   * pending HTTPS request — called from the adapter's `onUnload` so a slow
   * parcel.app endpoint can't keep the adapter alive past js-controller's
   * 4-second kill deadline.
   */
  private readonly inflight = new Set<AbortController>();

  /** @param apiKey The parcel.app API key */
  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * v0.4.2 (P1): abort every in-flight HTTPS request. Idempotent.
   */
  cancelAll(): void {
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
      const err = new Error("API error: malformed response") as Error & {
        code: string;
      };
      err.code = "API_ERROR";
      throw err;
    }

    if (!isTrueish(response.success)) {
      const rawCode = typeof response.error_code === "string" ? response.error_code : "";
      const rawMsg = typeof response.error_message === "string" ? response.error_message : "";
      const code = rawCode || rawMsg || "UNKNOWN";
      const err = new Error(`API error: ${rawMsg || code}`) as Error & {
        code: string;
      };
      err.code = rawCode === "INVALID_API_KEY" ? "INVALID_API_KEY" : "API_ERROR";
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
  async addDelivery(delivery: AddDeliveryRequest): Promise<AddDeliveryResponse> {
    return this.request<AddDeliveryResponse>("POST", "/add-delivery/", true, delivery);
  }

  /** Get carrier names (cached after first call) */
  async getCarrierNames(): Promise<CarrierMap> {
    if (this.carrierCache) {
      return this.carrierCache;
    }

    try {
      const raw = await this.request<unknown>("GET", "/supported_carriers.json", false);
      // API-drift guard: must be a plain object (not null, array, or primitive)
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        this.carrierCache = raw as CarrierMap;
      } else {
        return {};
      }
    } catch {
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
  async getCarrierName(carrierCode: unknown): Promise<string> {
    // API-drift guard: non-string codes fall back to "UNKNOWN"
    if (typeof carrierCode !== "string" || carrierCode.length === 0) {
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
    return new Promise((resolve, reject) => {
      // v0.4.2 (E3): URL-shape validation defensive — paths are hardcoded
      // upstream but a future caller could pass garbage; surface a clear
      // error class instead of a TypeError thrown sync from the executor.
      let url: URL;
      try {
        url = new URL(`${API_BASE}${path}`);
      } catch {
        const err = new Error(`Invalid URL: ${API_BASE}${path}`) as Error & { code: string };
        err.code = "INVALID_URL";
        reject(err);
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

      const req = https.request(options, res => {
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
          // v0.4.2 (P9): drop the connection on oversized responses so a
          // compromised or misconfigured endpoint can't OOM the adapter.
          if (bodyBytes > MAX_BODY_BYTES) {
            oversized = true;
            req.destroy(new Error(`Response body exceeds ${MAX_BODY_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          cleanup();
          if (oversized) {
            const err = new Error("Response body too large") as Error & { code: string };
            err.code = "BODY_TOO_LARGE";
            reject(err);
            return;
          }
          const raw = Buffer.concat(chunks).toString("utf-8");

          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            if (res.statusCode === 429) {
              // v0.4.2 (P6): clamp Retry-After parser. Bogus values (0,
              // negative, NaN) used to fall through `>0` and default to
              // 5 min — keep that, but also reject infinity/extreme.
              const retryAfter = parseInt(res.headers["retry-after"] || "", 10);
              const err = new Error("Rate limit exceeded") as Error & {
                code: string;
                retryAfterSeconds: number;
              };
              err.code = "RATE_LIMITED";
              err.retryAfterSeconds =
                Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(24 * 3600, retryAfter) : 5 * 60;
              reject(err);
              return;
            }
            // v0.4.2 (P3): split 401 (invalid key) from 403 (permission /
            // no premium). Adapter treats them differently — INVALID_API_KEY
            // says "fix the key", FORBIDDEN says "fix the account".
            const err = new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`) as Error & { code: string };
            if (res.statusCode === 401) {
              err.code = "INVALID_API_KEY";
            } else if (res.statusCode === 403) {
              err.code = "FORBIDDEN";
            } else {
              err.code = "HTTP_ERROR";
            }
            reject(err);
            return;
          }

          try {
            resolve(JSON.parse(raw) as T);
          } catch {
            reject(new Error(`JSON parse error: ${raw.substring(0, 200)}`));
          }
        });
      });

      ctrl.signal.addEventListener("abort", () => {
        req.destroy(new Error("Request aborted"));
      });

      req.on("timeout", () => {
        req.destroy();
        cleanup();
        reject(new Error("Request timeout"));
      });

      req.on("error", err => {
        cleanup();
        reject(err);
      });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }
}
