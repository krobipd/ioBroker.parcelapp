"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StateManager = void 0;
const types_1 = require("./types");
class StateManager {
    adapter;
    constructor(adapter) {
        this.adapter = adapter;
    }
    /** Sanitize a string for use as ioBroker object ID */
    sanitize(name) {
        return (name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "")
            .slice(0, 50) || "unknown");
    }
    /** Build a unique package ID from a delivery */
    packageId(delivery) {
        let id = this.sanitize(delivery.tracking_number);
        if (delivery.extra_information) {
            id += `_${this.sanitize(delivery.extra_information)}`;
        }
        return id;
    }
    /** Update or create all states for a delivery */
    async updateDelivery(delivery, carrierName) {
        const pkgId = this.packageId(delivery);
        const devicePath = `deliveries.${pkgId}`;
        // Ensure device exists
        await this.adapter.extendObjectAsync(devicePath, {
            type: "device",
            common: {
                name: delivery.description || `Package ${delivery.tracking_number}`,
            },
            native: {},
        });
        const statusCode = parseInt(delivery.status_code, 10) || 0;
        const lang = this.adapter.config.language || "de";
        const labels = lang === "de" ? types_1.STATUS_LABELS_DE : types_1.STATUS_LABELS_EN;
        // Update all states
        await Promise.all([
            this.createAndSet(`${devicePath}.carrier`, {
                name: "Carrier",
                type: "string",
                role: "text",
                read: true,
                write: false,
            }, carrierName),
            this.createAndSet(`${devicePath}.status`, {
                name: "Status",
                type: "string",
                role: "text",
                read: true,
                write: false,
            }, labels[statusCode] || `Unknown (${statusCode})`),
            this.createAndSet(`${devicePath}.statusCode`, {
                name: "Status Code",
                type: "number",
                role: "value",
                read: true,
                write: false,
            }, statusCode),
            this.createAndSet(`${devicePath}.description`, {
                name: "Description",
                type: "string",
                role: "text",
                read: true,
                write: false,
            }, delivery.description || ""),
            this.createAndSet(`${devicePath}.trackingNumber`, {
                name: "Tracking Number",
                type: "string",
                role: "text",
                read: true,
                write: false,
            }, delivery.tracking_number),
            this.createAndSet(`${devicePath}.extraInfo`, {
                name: "Extra Information",
                type: "string",
                role: "text",
                read: true,
                write: false,
            }, delivery.extra_information || ""),
            this.createAndSet(`${devicePath}.deliveryWindow`, {
                name: "Delivery Window",
                type: "string",
                role: "text",
                read: true,
                write: false,
            }, this.calculateDeliveryWindow(delivery)),
            this.createAndSet(`${devicePath}.deliveryEstimate`, {
                name: "Delivery Estimate",
                type: "string",
                role: "text",
                read: true,
                write: false,
            }, this.calculateDeliveryEstimate(delivery)),
            this.createAndSet(`${devicePath}.lastEvent`, {
                name: "Last Event",
                type: "string",
                role: "text",
                read: true,
                write: false,
            }, this.formatLastEvent(delivery)),
            this.createAndSet(`${devicePath}.lastLocation`, {
                name: "Last Location",
                type: "string",
                role: "text",
                read: true,
                write: false,
            }, this.extractLastLocation(delivery)),
            this.createAndSet(`${devicePath}.lastUpdated`, {
                name: "Last Updated",
                type: "string",
                role: "date",
                read: true,
                write: false,
            }, new Date().toISOString()),
        ]);
    }
    /** Update summary states */
    async updateSummary(deliveries) {
        // Ensure summary channel
        await this.adapter.extendObjectAsync("summary", {
            type: "channel",
            common: { name: "Summary" },
            native: {},
        });
        const activeDeliveries = deliveries.filter((d) => parseInt(d.status_code, 10) !== 0);
        const todayDeliveries = activeDeliveries.filter((d) => {
            const estimate = this.calculateDeliveryEstimate(d);
            return estimate === "heute" || estimate === "today";
        });
        await Promise.all([
            this.createAndSet("summary.activeCount", {
                name: "Active Deliveries",
                type: "number",
                role: "value",
                read: true,
                write: false,
            }, activeDeliveries.length),
            this.createAndSet("summary.todayCount", {
                name: "Deliveries Today",
                type: "number",
                role: "value",
                read: true,
                write: false,
            }, todayDeliveries.length),
            this.createAndSet("summary.deliveryWindow", {
                name: "Combined Delivery Window",
                type: "string",
                role: "text",
                read: true,
                write: false,
            }, this.calculateCombinedWindow(todayDeliveries)),
            this.createAndSet("summary.json", {
                name: "All Deliveries (JSON)",
                type: "string",
                role: "json",
                read: true,
                write: false,
            }, JSON.stringify(activeDeliveries)),
        ]);
    }
    /** Remove deliveries that are no longer active */
    async cleanupDeliveries(activeIds) {
        const activeSet = new Set(activeIds.map((id) => `deliveries.${id}`));
        const objects = await this.adapter.getObjectViewAsync("system", "device", {
            startkey: `${this.adapter.namespace}.deliveries.`,
            endkey: `${this.adapter.namespace}.deliveries.\u9999`,
        });
        for (const row of objects.rows) {
            const relativeId = row.id.replace(`${this.adapter.namespace}.`, "");
            if (relativeId.startsWith("deliveries.") && !activeSet.has(relativeId)) {
                await this.adapter.delObjectAsync(relativeId, { recursive: true });
                this.adapter.log.debug(`Removed stale delivery: ${relativeId}`);
            }
        }
    }
    /** Calculate delivery time window string — only from Unix timestamps (date strings lack time precision) */
    calculateDeliveryWindow(delivery) {
        const statusCode = parseInt(delivery.status_code, 10) || 0;
        if (![2, 4, 8].includes(statusCode)) {
            return "";
        }
        const formatTime = (timestamp) => {
            if (!timestamp) {
                return null;
            }
            return new Date(timestamp * 1000).toLocaleTimeString("de-DE", {
                hour: "2-digit",
                minute: "2-digit",
            });
        };
        const start = formatTime(delivery.timestamp_expected);
        const end = formatTime(delivery.timestamp_expected_end);
        if (!start) {
            return "";
        }
        return end ? `${start} - ${end}` : start;
    }
    /** Calculate human-readable delivery estimate */
    calculateDeliveryEstimate(delivery) {
        const statusCode = parseInt(delivery.status_code, 10) || 0;
        if (![2, 4, 8].includes(statusCode)) {
            return "";
        }
        let expectedDate = null;
        if (delivery.timestamp_expected) {
            expectedDate = new Date(delivery.timestamp_expected * 1000);
        }
        else if (delivery.date_expected) {
            expectedDate = new Date(delivery.date_expected);
        }
        if (!expectedDate || isNaN(expectedDate.getTime())) {
            return "";
        }
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const expectedStart = new Date(expectedDate.getFullYear(), expectedDate.getMonth(), expectedDate.getDate());
        const diffDays = Math.round((expectedStart.getTime() - todayStart.getTime()) / (1000 * 60 * 60 * 24));
        const lang = this.adapter.config.language || "de";
        if (lang === "de") {
            if (diffDays < 0) {
                return "überfällig";
            }
            if (diffDays === 0) {
                return "heute";
            }
            if (diffDays === 1) {
                return "morgen";
            }
            return `in ${diffDays} Tagen`;
        }
        if (diffDays < 0) {
            return "overdue";
        }
        if (diffDays === 0) {
            return "today";
        }
        if (diffDays === 1) {
            return "tomorrow";
        }
        return `in ${diffDays} days`;
    }
    /** Format the latest tracking event */
    formatLastEvent(delivery) {
        if (!delivery.events || delivery.events.length === 0) {
            return "";
        }
        const latest = delivery.events[0];
        const parts = [];
        if (latest.event) {
            parts.push(latest.event);
        }
        if (latest.date) {
            parts.push(latest.date);
        }
        return parts.join(" - ");
    }
    /** Extract location from latest event */
    extractLastLocation(delivery) {
        if (!delivery.events || delivery.events.length === 0) {
            return "";
        }
        return delivery.events[0].location || "";
    }
    /** Calculate combined delivery window for today's packages */
    calculateCombinedWindow(todayDeliveries) {
        const windows = todayDeliveries
            .map((d) => this.calculateDeliveryWindow(d))
            .filter((w) => w.length > 0);
        if (windows.length === 0) {
            return "";
        }
        if (windows.length === 1) {
            return windows[0];
        }
        // Parse all times and find earliest start / latest end
        const times = [];
        for (const w of windows) {
            const match = w.match(/(\d{2}:\d{2})(?:\s*-\s*(\d{2}:\d{2}))?/);
            if (match) {
                times.push({
                    start: match[1],
                    end: match[2] || match[1],
                });
            }
        }
        if (times.length === 0) {
            return "";
        }
        times.sort((a, b) => a.start.localeCompare(b.start));
        return `${times[0].start} - ${times[times.length - 1].end}`;
    }
    /** Create/extend an object and set its value */
    async createAndSet(id, common, val) {
        await this.adapter.extendObjectAsync(id, {
            type: "state",
            common,
            native: {},
        });
        await this.adapter.setStateAsync(id, { val, ack: true });
    }
}
exports.StateManager = StateManager;
