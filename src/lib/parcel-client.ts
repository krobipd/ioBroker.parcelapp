import * as https from "node:https";
import type {
  ParcelApiResponse,
  ParcelDelivery,
  AddDeliveryRequest,
  AddDeliveryResponse,
  CarrierMap,
} from "./types";

const API_BASE = "https://api.parcel.app/external";
const REQUEST_TIMEOUT = 15_000;

/** HTTP client for the parcel.app API */
export class ParcelClient {
  private apiKey: string;
  private carrierCache: CarrierMap | null = null;

  /** @param apiKey The parcel.app API key */
  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Fetch deliveries from parcel.app.
   *
   * @param filterMode Filter active or recent deliveries
   */
  async getDeliveries(
    filterMode: "active" | "recent" = "active",
  ): Promise<ParcelDelivery[]> {
    const response = await this.request<ParcelApiResponse>(
      "GET",
      `/deliveries/?filter_mode=${filterMode}`,
      true,
    );

    if (!response.success) {
      const code = response.error_code || response.error_message || "UNKNOWN";
      const err = new Error(
        `API error: ${response.error_message || code}`,
      ) as Error & {
        code: string;
      };
      err.code = code === "INVALID_API_KEY" ? "INVALID_API_KEY" : "API_ERROR";
      throw err;
    }

    return response.deliveries || [];
  }

  /**
   * Add a new delivery to parcel.app.
   *
   * @param delivery The delivery to add
   */
  async addDelivery(
    delivery: AddDeliveryRequest,
  ): Promise<AddDeliveryResponse> {
    return this.request<AddDeliveryResponse>(
      "POST",
      "/add-delivery/",
      true,
      delivery,
    );
  }

  /** Get carrier names (cached after first call) */
  async getCarrierNames(): Promise<CarrierMap> {
    if (this.carrierCache) {
      return this.carrierCache;
    }

    try {
      this.carrierCache = await this.request<CarrierMap>(
        "GET",
        "/supported_carriers.json",
        false,
      );
    } catch {
      this.carrierCache = {};
    }

    return this.carrierCache;
  }

  /**
   * Resolve a carrier code to a display name.
   *
   * @param carrierCode The carrier code from API
   */
  async getCarrierName(carrierCode: string): Promise<string> {
    const carriers = await this.getCarrierNames();
    return carriers[carrierCode] || carrierCode.toUpperCase();
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
  private request<T>(
    method: string,
    path: string,
    authenticated: boolean,
    body?: unknown,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${API_BASE}${path}`);

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

      const req = https.request(options, (res) => {
        const chunks: Buffer[] = [];

        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");

          if (
            res.statusCode &&
            (res.statusCode < 200 || res.statusCode >= 300)
          ) {
            if (res.statusCode === 429) {
              const retryAfter = parseInt(res.headers["retry-after"] || "", 10);
              const err = new Error("Rate limit exceeded") as Error & {
                code: string;
                retryAfterSeconds: number;
              };
              err.code = "RATE_LIMITED";
              // Use Retry-After header or default to 5 minutes
              err.retryAfterSeconds = retryAfter > 0 ? retryAfter : 5 * 60;
              reject(err);
              return;
            }
            const err = new Error(
              `HTTP ${res.statusCode}: ${res.statusMessage}`,
            ) as Error & { code: string };
            err.code =
              res.statusCode === 401 || res.statusCode === 403
                ? "INVALID_API_KEY"
                : "HTTP_ERROR";
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
