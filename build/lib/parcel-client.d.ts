import type { ParcelDelivery, AddDeliveryRequest, AddDeliveryResponse, CarrierMap } from "./types";
/** HTTP client for the parcel.app API */
export declare class ParcelClient {
    private apiKey;
    private carrierCache;
    /** @param apiKey The parcel.app API key */
    constructor(apiKey: string);
    /**
     * Fetch deliveries from parcel.app.
     *
     * @param filterMode Filter active or recent deliveries
     */
    getDeliveries(filterMode?: "active" | "recent"): Promise<ParcelDelivery[]>;
    /**
     * Add a new delivery to parcel.app.
     *
     * @param delivery The delivery to add
     */
    addDelivery(delivery: AddDeliveryRequest): Promise<AddDeliveryResponse>;
    /** Get carrier names (cached after first call) */
    getCarrierNames(): Promise<CarrierMap>;
    /**
     * Resolve a carrier code to a display name.
     *
     * @param carrierCode The carrier code from API
     */
    getCarrierName(carrierCode: string): Promise<string>;
    /** Test if the API key is valid */
    testConnection(): Promise<{
        success: boolean;
        message: string;
    }>;
    /**
     * Execute an HTTP request against the parcel.app API.
     *
     * @param method HTTP method
     * @param path API path
     * @param authenticated Whether to send the API key
     * @param body Optional request body
     */
    private request;
}
//# sourceMappingURL=parcel-client.d.ts.map