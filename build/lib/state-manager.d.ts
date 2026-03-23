import type { AdapterInstance } from "@iobroker/adapter-core";
import type { ParcelDelivery } from "./types";
/** Manages ioBroker states for parcel deliveries */
export declare class StateManager {
    private adapter;
    /** @param adapter The ioBroker adapter instance */
    constructor(adapter: AdapterInstance);
    /**
     * Sanitize a string for use as ioBroker object ID.
     *
     * @param name Raw string to sanitize
     */
    sanitize(name: string): string;
    /**
     * Build a unique package ID from a delivery.
     *
     * @param delivery The delivery to build an ID for
     */
    packageId(delivery: ParcelDelivery): string;
    /**
     * Update or create all states for a delivery.
     *
     * @param delivery The delivery data from API
     * @param carrierName Resolved carrier display name
     */
    updateDelivery(delivery: ParcelDelivery, carrierName: string): Promise<void>;
    /**
     * Update summary states. Expects already-filtered active deliveries.
     *
     * @param activeDeliveries Only active (non-delivered) deliveries
     */
    updateSummary(activeDeliveries: ParcelDelivery[]): Promise<void>;
    /**
     * Remove deliveries that are no longer active.
     *
     * @param activeIds List of currently active package IDs
     */
    cleanupDeliveries(activeIds: string[]): Promise<void>;
    /**
     * Calculate delivery time window — only from Unix timestamps.
     *
     * @param delivery The delivery data
     * @param statusCode Pre-parsed status code
     */
    private calculateDeliveryWindow;
    /**
     * Calculate human-readable delivery estimate.
     *
     * @param delivery The delivery data
     * @param statusCode Pre-parsed status code
     */
    private calculateDeliveryEstimate;
    /**
     * Format the latest tracking event.
     *
     * @param delivery The delivery data
     */
    private formatLastEvent;
    /**
     * Extract location from latest event.
     *
     * @param delivery The delivery data
     */
    private extractLastLocation;
    /**
     * Calculate combined delivery window for today's packages.
     *
     * @param todayDeliveries Deliveries expected today
     */
    private calculateCombinedWindow;
    /**
     * Create/extend a read-only state and set its value.
     *
     * @param id State ID relative to adapter namespace
     * @param name Display name
     * @param type Value type
     * @param role ioBroker role
     * @param val Value to set
     */
    private createAndSet;
}
//# sourceMappingURL=state-manager.d.ts.map