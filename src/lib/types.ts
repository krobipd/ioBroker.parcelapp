/** API response from parcel.app deliveries endpoint */
export interface ParcelApiResponse {
  /** Whether the request was successful */
  success: boolean;
  /** Error message if request failed */
  error_message?: string;
  /** List of deliveries */
  deliveries?: ParcelDelivery[];
}

/** Single delivery from the parcel.app API */
export interface ParcelDelivery {
  /** Carrier identifier (optional: the API normally always sends it, but the adapter guards against drift) */
  carrier_code?: string;
  /** User-defined description (optional: guarded against drift) */
  description?: string;
  /**
   * Status code (int 0-8). The API sends a number; the type also admits a
   * numeric string, which `parseStatus` tolerates for drift safety. Widening
   * the type here lets `parseStatus` narrow with plain `typeof` guards instead
   * of an `as unknown` cast that hid the real runtime shape.
   */
  status_code: number | string;
  /** Tracking number (optional: guarded against drift) */
  tracking_number?: string;
  /** Extra info (postal code, email) */
  extra_information?: string;
  /** Expected delivery date/time as a string, without timezone (carrier-dependent format) */
  date_expected?: string;
  /** End of the delivery window as a date/time string (present when the carrier reports a range) */
  date_expected_end?: string;
  /** Expected delivery Unix timestamp (only when the carrier provides full date/time/timezone) */
  timestamp_expected?: number;
  /** Expected delivery end Unix timestamp */
  timestamp_expected_end?: number;
  /** Tracking events, newest first (confirmed across multiple parcel.app clients) */
  events?: ParcelEvent[];
}

/** Single tracking event */
export interface ParcelEvent {
  /** Event description (optional: the API normally sends it, but the adapter guards against drift) */
  event?: string;
  /** Event date string (optional: guarded against drift) */
  date?: string;
  /** Event location */
  location?: string;
}

/** Request body for adding a delivery */
export interface AddDeliveryRequest {
  /** Tracking number to add */
  tracking_number: string;
  /** Carrier code */
  carrier_code: string;
  /** User description */
  description: string;
  /** Tracking language */
  language?: string;
  /** Send push confirmation */
  send_push_confirmation?: boolean;
}

/** Add delivery API response */
export interface AddDeliveryResponse {
  /** Whether the delivery was added */
  success: boolean;
  /** Error message if failed */
  error_message?: string;
}

/** Carrier names mapping (carrier_code → display name) */
export type CarrierMap = Record<string, string>;

/**
 * Machine-readable codes carried by every Error the ParcelClient rejects with.
 * Single source of truth for the client↔adapter error contract — main.ts
 * classifies against these, so a typo on either side is a compile error.
 */
export type ApiErrorCode =
  | "RATE_LIMITED"
  | "INVALID_API_KEY"
  | "FORBIDDEN"
  | "HTTP_ERROR"
  | "API_ERROR"
  | "BODY_TOO_LARGE"
  | "INVALID_URL"
  | "TIMEOUT"
  | "PARSE_ERROR"
  | "ABORTED";

/** Error contract between ParcelClient and the adapter. */
export interface ApiError extends Error {
  /** Machine-readable failure class the adapter dispatches on. */
  code: ApiErrorCode;
  /** Present on RATE_LIMITED: server-provided cooldown in seconds. */
  retryAfterSeconds?: number;
}

/*
 * v0.10.0 (L20): the former STATUS_LABELS table (status codes 0-8 in 11
 * languages) moved to admin/i18n/<lang>.json as status_0 … status_8 — one
 * translation system (adapter-core I18n) instead of two parallel ones.
 * Lookup lives in i18n.ts (statusLabel).
 */

/** Status code the API uses for a delivered package (drives the active filter and autoRemove). */
export const DELIVERED_STATUS_CODE = 0;

/**
 * Sentinel status code for unparseable API drift. Distinct from 0 (Delivered)
 * so a garbage `status_code` keeps the package visible (the active filter is
 * `status !== DELIVERED_STATUS_CODE`) and renders as "Unknown" instead of
 * silently dropping it.
 */
export const UNKNOWN_STATUS_CODE = -1;

// Augment the ioBroker global namespace
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ioBroker {
    interface AdapterConfig {
      /** parcel.app API key */
      apiKey: string;
      /** Polling interval in minutes */
      pollInterval: number;
      /** Automatically remove delivered packages from states */
      autoRemoveDelivered: boolean;
    }
  }
}
