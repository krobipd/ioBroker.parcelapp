/** API response from parcel.app deliveries endpoint */
export interface ParcelApiResponse {
    /** Whether the request was successful */
    success: boolean;
    /** Error message if request failed */
    error_message?: string;
    /** Error code if request failed */
    error_code?: string;
    /** List of deliveries */
    deliveries?: ParcelDelivery[];
}
/** Single delivery from the parcel.app API */
export interface ParcelDelivery {
    /** Carrier identifier */
    carrier_code: string;
    /** User-defined description */
    description: string;
    /** Status code (0-8 as string) */
    status_code: string;
    /** Tracking number */
    tracking_number: string;
    /** Extra info (postal code, email) */
    extra_information?: string;
    /** Expected delivery date */
    date_expected?: string;
    /** Expected delivery date end */
    date_expected_end?: string;
    /** Expected delivery Unix timestamp */
    timestamp_expected?: number;
    /** Expected delivery end Unix timestamp */
    timestamp_expected_end?: number;
    /** Tracking events (newest first) */
    events?: ParcelEvent[];
}
/** Single tracking event */
export interface ParcelEvent {
    /** Event description */
    event: string;
    /** Event date string */
    date: string;
    /** Event location */
    location?: string;
    /** Additional details */
    additional?: string;
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
/** Delivery status codes (0-8) in German */
export declare const STATUS_LABELS_DE: Record<number, string>;
/** Delivery status codes (0-8) in English */
export declare const STATUS_LABELS_EN: Record<number, string>;
declare global {
    namespace ioBroker {
        interface AdapterConfig {
            /** parcel.app API key */
            apiKey: string;
            /** Polling interval in minutes */
            pollInterval: number;
            /** Language for status labels */
            language: "de" | "en";
            /** Automatically remove delivered packages from states */
            autoRemoveDelivered: boolean;
        }
    }
}
//# sourceMappingURL=types.d.ts.map