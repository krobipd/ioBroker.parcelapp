/** API response from parcel.app deliveries endpoint */
export interface ParcelApiResponse {
    success: boolean;
    error_message?: string;
    error_code?: string;
    deliveries?: ParcelDelivery[];
}
/** Single delivery from the parcel.app API */
export interface ParcelDelivery {
    carrier_code: string;
    description: string;
    status_code: string;
    tracking_number: string;
    extra_information?: string;
    date_expected?: string;
    date_expected_end?: string;
    timestamp_expected?: number;
    timestamp_expected_end?: number;
    events?: ParcelEvent[];
}
/** Single tracking event */
export interface ParcelEvent {
    event: string;
    date: string;
    location?: string;
    additional?: string;
}
/** Request body for adding a delivery */
export interface AddDeliveryRequest {
    tracking_number: string;
    carrier_code: string;
    description: string;
    language?: string;
    send_push_confirmation?: boolean;
}
/** Add delivery API response */
export interface AddDeliveryResponse {
    success: boolean;
    error_message?: string;
}
/** Carrier names mapping (carrier_code → display name) */
export type CarrierMap = Record<string, string>;
/** Delivery status codes (0-8) */
export declare const STATUS_LABELS_DE: Record<number, string>;
export declare const STATUS_LABELS_EN: Record<number, string>;
/** Adapter configuration from native settings */
export interface AdapterConfig {
    /** parcel.app API key */
    apiKey: string;
    /** Polling interval in minutes */
    pollInterval: number;
    /** Filter mode for deliveries */
    filterMode: "active" | "recent";
    /** Language for status labels */
    language: "de" | "en";
}
declare global {
    namespace ioBroker {
        interface AdapterConfig {
            apiKey: string;
            pollInterval: number;
            filterMode: "active" | "recent";
            language: "de" | "en";
        }
    }
}
//# sourceMappingURL=types.d.ts.map