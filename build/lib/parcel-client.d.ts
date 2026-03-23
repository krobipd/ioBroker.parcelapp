import type { ParcelDelivery, AddDeliveryRequest, AddDeliveryResponse, CarrierMap } from "./types";
export declare class ParcelClient {
    private apiKey;
    private carrierCache;
    constructor(apiKey: string);
    /** Fetch deliveries from parcel.app */
    getDeliveries(filterMode?: "active" | "recent"): Promise<ParcelDelivery[]>;
    /** Add a new delivery to parcel.app */
    addDelivery(delivery: AddDeliveryRequest): Promise<AddDeliveryResponse>;
    /** Get carrier names (cached after first call) */
    getCarrierNames(): Promise<CarrierMap>;
    /** Resolve a carrier code to a display name */
    getCarrierName(carrierCode: string): Promise<string>;
    /** Test if the API key is valid */
    testConnection(): Promise<{
        success: boolean;
        message: string;
    }>;
    private request;
}
//# sourceMappingURL=parcel-client.d.ts.map