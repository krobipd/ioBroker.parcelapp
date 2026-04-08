import type { AdapterInstance } from "@iobroker/adapter-core";
import type { ParcelDelivery } from "./types";
import { STATUS_LABELS_DE, STATUS_LABELS_EN } from "./types";

/** Status codes that have expected delivery date/time */
const TRACKABLE_STATUSES = new Set([2, 4, 8]);

const ESTIMATE_LABELS: Record<string, Record<string, string>> = {
  de: {
    overdue: "überfällig",
    today: "heute",
    tomorrow: "morgen",
    days: "in %d Tagen",
  },
  en: {
    overdue: "overdue",
    today: "today",
    tomorrow: "tomorrow",
    days: "in %d days",
  },
};

/** Manages ioBroker states for parcel deliveries */
export class StateManager {
  private adapter: AdapterInstance;

  /** @param adapter The ioBroker adapter instance */
  constructor(adapter: AdapterInstance) {
    this.adapter = adapter;
  }

  /**
   * Sanitize a string for use as ioBroker object ID (see adapter.FORBIDDEN_CHARS).
   *
   * @param name Raw string to sanitize
   */
  sanitize(name: string): string {
    return (
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 50) || "unknown"
    );
  }

  /**
   * Build a unique package ID from a delivery.
   *
   * @param delivery The delivery to build an ID for
   */
  packageId(delivery: ParcelDelivery): string {
    let id = this.sanitize(delivery.tracking_number);
    if (delivery.extra_information) {
      id += `_${this.sanitize(delivery.extra_information)}`;
    }
    return id;
  }

  /**
   * Update or create all states for a delivery.
   *
   * @param delivery The delivery data from API
   * @param carrierName Resolved carrier display name
   */
  async updateDelivery(
    delivery: ParcelDelivery,
    carrierName: string,
  ): Promise<void> {
    const pkgId = this.packageId(delivery);
    const devicePath = `deliveries.${pkgId}`;

    await this.adapter.extendObjectAsync(devicePath, {
      type: "device",
      common: {
        name: delivery.description || `Package ${delivery.tracking_number}`,
      },
      native: {},
    });

    const statusCode = parseInt(delivery.status_code, 10) || 0;
    const lang = this.adapter.config.language || "de";
    const labels = lang === "de" ? STATUS_LABELS_DE : STATUS_LABELS_EN;

    await Promise.all([
      this.createAndSet(
        `${devicePath}.carrier`,
        "Carrier",
        "string",
        "text",
        carrierName,
      ),
      this.createAndSet(
        `${devicePath}.status`,
        "Status",
        "string",
        "text",
        labels[statusCode] || `Unknown (${statusCode})`,
      ),
      this.createAndSet(
        `${devicePath}.statusCode`,
        "Status Code",
        "number",
        "value",
        statusCode,
      ),
      this.createAndSet(
        `${devicePath}.description`,
        "Description",
        "string",
        "text",
        delivery.description || "",
      ),
      this.createAndSet(
        `${devicePath}.trackingNumber`,
        "Tracking Number",
        "string",
        "text",
        delivery.tracking_number,
      ),
      this.createAndSet(
        `${devicePath}.extraInfo`,
        "Extra Information",
        "string",
        "text",
        delivery.extra_information || "",
      ),
      this.createAndSet(
        `${devicePath}.deliveryWindow`,
        "Delivery Window",
        "string",
        "text",
        this.calculateDeliveryWindow(delivery, statusCode),
      ),
      this.createAndSet(
        `${devicePath}.deliveryEstimate`,
        "Delivery Estimate",
        "string",
        "text",
        this.calculateDeliveryEstimate(delivery, statusCode),
      ),
      this.createAndSet(
        `${devicePath}.lastEvent`,
        "Last Event",
        "string",
        "text",
        this.formatLastEvent(delivery),
      ),
      this.createAndSet(
        `${devicePath}.lastLocation`,
        "Last Location",
        "string",
        "text",
        this.extractLastLocation(delivery),
      ),
      this.createAndSet(
        `${devicePath}.lastUpdated`,
        "Last Updated",
        "string",
        "date",
        new Date().toISOString(),
      ),
    ]);
  }

  /**
   * Update summary states. Expects already-filtered active deliveries.
   *
   * @param activeDeliveries Only active (non-delivered) deliveries
   */
  async updateSummary(activeDeliveries: ParcelDelivery[]): Promise<void> {
    await this.adapter.extendObjectAsync("summary", {
      type: "channel",
      common: { name: "Summary" },
      native: {},
    });

    const todayDeliveries = activeDeliveries.filter((d) => {
      const statusCode = parseInt(d.status_code, 10) || 0;
      const estimate = this.calculateDeliveryEstimate(d, statusCode);
      return estimate === "heute" || estimate === "today";
    });

    await Promise.all([
      this.createAndSet(
        "summary.activeCount",
        "Active Deliveries",
        "number",
        "value",
        activeDeliveries.length,
      ),
      this.createAndSet(
        "summary.todayCount",
        "Deliveries Today",
        "number",
        "value",
        todayDeliveries.length,
      ),
      this.createAndSet(
        "summary.deliveryWindow",
        "Combined Delivery Window",
        "string",
        "text",
        this.calculateCombinedWindow(todayDeliveries),
      ),
    ]);
  }

  /**
   * Remove deliveries that are no longer active.
   *
   * @param activeIds List of currently active package IDs
   */
  async cleanupDeliveries(activeIds: string[]): Promise<void> {
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

  /**
   * Calculate delivery time window — only from Unix timestamps.
   *
   * @param delivery The delivery data
   * @param statusCode Pre-parsed status code
   */
  private calculateDeliveryWindow(
    delivery: ParcelDelivery,
    statusCode: number,
  ): string {
    if (!TRACKABLE_STATUSES.has(statusCode)) {
      return "";
    }

    const formatTime = (timestamp?: number): string | null => {
      if (!timestamp) {
        return null;
      }
      const d = new Date(timestamp * 1000);
      return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
    };

    const start = formatTime(delivery.timestamp_expected);
    const end = formatTime(delivery.timestamp_expected_end);

    if (!start) {
      return "";
    }
    return end ? `${start} - ${end}` : start;
  }

  /**
   * Calculate human-readable delivery estimate.
   *
   * @param delivery The delivery data
   * @param statusCode Pre-parsed status code
   */
  private calculateDeliveryEstimate(
    delivery: ParcelDelivery,
    statusCode: number,
  ): string {
    if (!TRACKABLE_STATUSES.has(statusCode)) {
      return "";
    }

    let expectedDate: Date | null = null;
    if (delivery.timestamp_expected) {
      expectedDate = new Date(delivery.timestamp_expected * 1000);
    } else if (delivery.date_expected) {
      expectedDate = new Date(delivery.date_expected);
    }

    if (!expectedDate || isNaN(expectedDate.getTime())) {
      return "";
    }

    const now = new Date();
    const todayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    );
    const expectedStart = new Date(
      expectedDate.getFullYear(),
      expectedDate.getMonth(),
      expectedDate.getDate(),
    );
    const diffDays = Math.round(
      (expectedStart.getTime() - todayStart.getTime()) / (1000 * 60 * 60 * 24),
    );

    const lang = this.adapter.config.language || "de";
    const l = ESTIMATE_LABELS[lang] || ESTIMATE_LABELS.en;

    if (diffDays < 0) {
      return l.overdue;
    }
    if (diffDays === 0) {
      return l.today;
    }
    if (diffDays === 1) {
      return l.tomorrow;
    }
    return l.days.replace("%d", String(diffDays));
  }

  /**
   * Format the latest tracking event.
   *
   * @param delivery The delivery data
   */
  private formatLastEvent(delivery: ParcelDelivery): string {
    if (!delivery.events || delivery.events.length === 0) {
      return "";
    }
    const latest = delivery.events[0];
    const parts: string[] = [];
    if (latest.event) {
      parts.push(latest.event);
    }
    if (latest.date) {
      parts.push(latest.date);
    }
    return parts.join(" - ");
  }

  /**
   * Extract location from latest event.
   *
   * @param delivery The delivery data
   */
  private extractLastLocation(delivery: ParcelDelivery): string {
    if (!delivery.events || delivery.events.length === 0) {
      return "";
    }
    return delivery.events[0].location || "";
  }

  /**
   * Calculate combined delivery window for today's packages.
   *
   * @param todayDeliveries Deliveries expected today
   */
  private calculateCombinedWindow(todayDeliveries: ParcelDelivery[]): string {
    const windows = todayDeliveries
      .map((d) => {
        const sc = parseInt(d.status_code, 10) || 0;
        return this.calculateDeliveryWindow(d, sc);
      })
      .filter((w) => w.length > 0);

    if (windows.length === 0) {
      return "";
    }
    if (windows.length === 1) {
      return windows[0];
    }

    const times: {
      /** Window start */ start: string;
      /** Window end */ end: string;
    }[] = [];
    for (const w of windows) {
      const match = w.match(/(\d{2}:\d{2})(?:\s*-\s*(\d{2}:\d{2}))?/);
      if (match) {
        times.push({ start: match[1], end: match[2] || match[1] });
      }
    }

    if (times.length === 0) {
      return "";
    }

    times.sort((a, b) => a.start.localeCompare(b.start));
    return `${times[0].start} - ${times[times.length - 1].end}`;
  }

  /**
   * Create/extend a read-only state and set its value.
   *
   * @param id State ID relative to adapter namespace
   * @param name Display name
   * @param type Value type
   * @param role ioBroker role
   * @param val Value to set
   */
  private async createAndSet(
    id: string,
    name: string,
    type: ioBroker.CommonType,
    role: string,
    val: ioBroker.StateValue,
  ): Promise<void> {
    await this.adapter.extendObjectAsync(id, {
      type: "state",
      common: { name, type, role, read: true, write: false },
      native: {},
    });
    await this.adapter.setStateAsync(id, { val, ack: true });
  }
}
