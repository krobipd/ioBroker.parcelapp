import type { AdapterInstance } from "@iobroker/adapter-core";
import type { ParcelDelivery } from "./types";
export declare class StateManager {
    private adapter;
    constructor(adapter: AdapterInstance);
    /** Sanitize a string for use as ioBroker object ID */
    sanitize(name: string): string;
    /** Build a unique package ID from a delivery */
    packageId(delivery: ParcelDelivery): string;
    /** Update or create all states for a delivery */
    updateDelivery(delivery: ParcelDelivery, carrierName: string): Promise<void>;
    /** Update summary states */
    updateSummary(deliveries: ParcelDelivery[]): Promise<void>;
    /** Remove deliveries that are no longer active */
    cleanupDeliveries(activeIds: string[]): Promise<void>;
    /** Calculate delivery time window string */
    private calculateDeliveryWindow;
    /** Calculate human-readable delivery estimate */
    private calculateDeliveryEstimate;
    /** Format the latest tracking event */
    private formatLastEvent;
    /** Extract location from latest event */
    private extractLastLocation;
    /** Calculate combined delivery window for today's packages */
    private calculateCombinedWindow;
    /** Create/extend an object and set its value */
    private createAndSet;
}
//# sourceMappingURL=state-manager.d.ts.map