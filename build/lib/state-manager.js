"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var state_manager_exports = {};
__export(state_manager_exports, {
  StateManager: () => StateManager,
  resolveLanguage: () => resolveLanguage
});
module.exports = __toCommonJS(state_manager_exports);
var import_types = require("./types");
const TRACKABLE_STATUSES = /* @__PURE__ */ new Set([2, 4, 8]);
function coerceNumber(v) {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === "string" && v.length > 0) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
const ESTIMATE_LABELS = {
  de: {
    overdue: "\xFCberf\xE4llig",
    today: "heute",
    tomorrow: "morgen",
    days: "in %d Tagen"
  },
  en: {
    overdue: "overdue",
    today: "today",
    tomorrow: "tomorrow",
    days: "in %d days"
  },
  ru: {
    overdue: "\u043F\u0440\u043E\u0441\u0440\u043E\u0447\u0435\u043D\u043E",
    today: "\u0441\u0435\u0433\u043E\u0434\u043D\u044F",
    tomorrow: "\u0437\u0430\u0432\u0442\u0440\u0430",
    days: "\u0447\u0435\u0440\u0435\u0437 %d \u0434\u043D."
  },
  pt: {
    overdue: "atrasado",
    today: "hoje",
    tomorrow: "amanh\xE3",
    days: "em %d dias"
  },
  nl: {
    overdue: "te laat",
    today: "vandaag",
    tomorrow: "morgen",
    days: "over %d dagen"
  },
  fr: {
    overdue: "en retard",
    today: "aujourd'hui",
    tomorrow: "demain",
    days: "dans %d jours"
  },
  it: {
    overdue: "in ritardo",
    today: "oggi",
    tomorrow: "domani",
    days: "tra %d giorni"
  },
  es: {
    overdue: "atrasado",
    today: "hoy",
    tomorrow: "ma\xF1ana",
    days: "en %d d\xEDas"
  },
  pl: {
    overdue: "zaleg\u0142e",
    today: "dzisiaj",
    tomorrow: "jutro",
    days: "za %d dni"
  },
  uk: {
    overdue: "\u043F\u0440\u043E\u0441\u0442\u0440\u043E\u0447\u0435\u043D\u043E",
    today: "\u0441\u044C\u043E\u0433\u043E\u0434\u043D\u0456",
    tomorrow: "\u0437\u0430\u0432\u0442\u0440\u0430",
    days: "\u0447\u0435\u0440\u0435\u0437 %d \u0434\u043D."
  },
  "zh-cn": {
    overdue: "\u5DF2\u903E\u671F",
    today: "\u4ECA\u5929",
    tomorrow: "\u660E\u5929",
    days: "%d \u5929\u540E"
  }
};
function resolveLanguage(language) {
  if (typeof language === "string" && import_types.SUPPORTED_LANGUAGES.includes(language)) {
    return language;
  }
  return import_types.FALLBACK_LANGUAGE;
}
class StateManager {
  adapter;
  language;
  /**
   * @param adapter The ioBroker adapter instance
   * @param language Language code from system.config.language (falls back to English)
   */
  constructor(adapter, language) {
    this.adapter = adapter;
    this.language = resolveLanguage(language);
  }
  /**
   * Sanitize a string for use as ioBroker object ID (see adapter.FORBIDDEN_CHARS).
   * API-drift guard: returns "unknown" for non-string input.
   *
   * @param name Raw value to sanitize (any type)
   */
  sanitize(name) {
    if (typeof name !== "string") {
      return "unknown";
    }
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50) || "unknown";
  }
  /**
   * Parse the status code from a delivery. API documents `status_code` as
   * a numeric string, but we accept numbers too and fall back to 0 for drift.
   *
   * @param delivery The delivery to parse
   */
  parseStatus(delivery) {
    const raw = delivery.status_code;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return Math.trunc(raw);
    }
    if (typeof raw === "string") {
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  }
  /**
   * Build a unique package ID from a delivery.
   *
   * @param delivery The delivery to build an ID for
   */
  packageId(delivery) {
    let id = this.sanitize(delivery.tracking_number);
    if (typeof delivery.extra_information === "string" && delivery.extra_information.length > 0) {
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
  async updateDelivery(delivery, carrierName) {
    const pkgId = this.packageId(delivery);
    const devicePath = `deliveries.${pkgId}`;
    const description = typeof delivery.description === "string" ? delivery.description : "";
    const trackingNumber = typeof delivery.tracking_number === "string" ? delivery.tracking_number : "";
    const extraInfo = typeof delivery.extra_information === "string" ? delivery.extra_information : "";
    await this.adapter.extendObjectAsync(devicePath, {
      type: "device",
      common: {
        name: description || `Package ${trackingNumber || pkgId}`
      },
      native: {}
    });
    const statusCode = this.parseStatus(delivery);
    const labels = import_types.STATUS_LABELS[this.language];
    const statusText = labels[statusCode] || `Unknown (${statusCode})`;
    await Promise.all([
      this.createAndSet(
        `${devicePath}.carrier`,
        "Carrier",
        "string",
        "text",
        carrierName
      ),
      this.createAndSet(
        `${devicePath}.status`,
        "Status",
        "string",
        "text",
        statusText
      ),
      this.createAndSet(
        `${devicePath}.statusCode`,
        "Status Code",
        "number",
        "value",
        statusCode
      ),
      this.createAndSet(
        `${devicePath}.description`,
        "Description",
        "string",
        "text",
        description
      ),
      this.createAndSet(
        `${devicePath}.trackingNumber`,
        "Tracking Number",
        "string",
        "text",
        trackingNumber
      ),
      this.createAndSet(
        `${devicePath}.extraInfo`,
        "Extra Information",
        "string",
        "text",
        extraInfo
      ),
      this.createAndSet(
        `${devicePath}.deliveryWindow`,
        "Delivery Window",
        "string",
        "text",
        this.calculateDeliveryWindow(delivery, statusCode)
      ),
      this.createAndSet(
        `${devicePath}.deliveryEstimate`,
        "Delivery Estimate",
        "string",
        "text",
        this.calculateDeliveryEstimate(delivery, statusCode)
      ),
      this.createAndSet(
        `${devicePath}.lastEvent`,
        "Last Event",
        "string",
        "text",
        this.formatLastEvent(delivery)
      ),
      this.createAndSet(
        `${devicePath}.lastLocation`,
        "Last Location",
        "string",
        "text",
        this.extractLastLocation(delivery)
      ),
      this.createAndSet(
        `${devicePath}.lastUpdated`,
        "Last Updated",
        "string",
        "date",
        (/* @__PURE__ */ new Date()).toISOString()
      )
    ]);
  }
  /**
   * Update summary states. Expects already-filtered active deliveries.
   * The `summary` channel itself is declared via io-package.json instanceObjects.
   *
   * @param activeDeliveries Only active (non-delivered) deliveries
   */
  async updateSummary(activeDeliveries) {
    const todayDeliveries = activeDeliveries.filter(
      (d) => this.isToday(d, this.parseStatus(d))
    );
    await Promise.all([
      this.createAndSet(
        "summary.activeCount",
        "Active Deliveries",
        "number",
        "value",
        activeDeliveries.length
      ),
      this.createAndSet(
        "summary.todayCount",
        "Deliveries Today",
        "number",
        "value",
        todayDeliveries.length
      ),
      this.createAndSet(
        "summary.deliveryWindow",
        "Combined Delivery Window",
        "string",
        "text",
        this.calculateCombinedWindow(todayDeliveries)
      )
    ]);
  }
  /**
   * Remove deliveries that are no longer active.
   *
   * @param activeIds List of currently active package IDs
   */
  async cleanupDeliveries(activeIds) {
    const activeSet = new Set(activeIds.map((id) => `deliveries.${id}`));
    const objects = await this.adapter.getObjectViewAsync("system", "device", {
      startkey: `${this.adapter.namespace}.deliveries.`,
      endkey: `${this.adapter.namespace}.deliveries.\u9999`
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
  calculateDeliveryWindow(delivery, statusCode) {
    if (!TRACKABLE_STATUSES.has(statusCode)) {
      return "";
    }
    const formatTime = (timestamp) => {
      const ts = coerceNumber(timestamp);
      if (ts === null || ts <= 0) {
        return null;
      }
      const d = new Date(ts * 1e3);
      if (Number.isNaN(d.getTime())) {
        return null;
      }
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
   * Days from today to the expected delivery date. Returns null when the
   * delivery has no usable expected date or is in a non-trackable status.
   *
   * @param delivery The delivery data
   * @param statusCode Pre-parsed status code
   */
  computeDiffDays(delivery, statusCode) {
    if (!TRACKABLE_STATUSES.has(statusCode)) {
      return null;
    }
    let expectedDate = null;
    const ts = coerceNumber(delivery.timestamp_expected);
    if (ts !== null && ts > 0) {
      expectedDate = new Date(ts * 1e3);
    } else if (typeof delivery.date_expected === "string" && delivery.date_expected.length > 0) {
      expectedDate = new Date(delivery.date_expected);
    }
    if (!expectedDate || isNaN(expectedDate.getTime())) {
      return null;
    }
    const now = /* @__PURE__ */ new Date();
    const todayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate()
    );
    const expectedStart = new Date(
      expectedDate.getFullYear(),
      expectedDate.getMonth(),
      expectedDate.getDate()
    );
    return Math.round(
      (expectedStart.getTime() - todayStart.getTime()) / (1e3 * 60 * 60 * 24)
    );
  }
  /**
   * Calculate human-readable delivery estimate.
   *
   * @param delivery The delivery data
   * @param statusCode Pre-parsed status code
   */
  calculateDeliveryEstimate(delivery, statusCode) {
    const diffDays = this.computeDiffDays(delivery, statusCode);
    if (diffDays === null) {
      return "";
    }
    const l = ESTIMATE_LABELS[this.language];
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
   * Whether the delivery is expected today. Language-agnostic, used by the
   * summary filter so `todayCount` works across all languages.
   *
   * @param delivery The delivery data
   * @param statusCode Pre-parsed status code
   */
  isToday(delivery, statusCode) {
    return this.computeDiffDays(delivery, statusCode) === 0;
  }
  /**
   * Format the latest tracking event.
   *
   * @param delivery The delivery data
   */
  formatLastEvent(delivery) {
    if (!Array.isArray(delivery.events) || delivery.events.length === 0) {
      return "";
    }
    const latest = delivery.events[0];
    if (!latest || typeof latest !== "object") {
      return "";
    }
    const parts = [];
    if (typeof latest.event === "string" && latest.event.length > 0) {
      parts.push(latest.event);
    }
    if (typeof latest.date === "string" && latest.date.length > 0) {
      parts.push(latest.date);
    }
    return parts.join(" - ");
  }
  /**
   * Extract location from latest event.
   *
   * @param delivery The delivery data
   */
  extractLastLocation(delivery) {
    if (!Array.isArray(delivery.events) || delivery.events.length === 0) {
      return "";
    }
    const latest = delivery.events[0];
    if (!latest || typeof latest !== "object") {
      return "";
    }
    return typeof latest.location === "string" ? latest.location : "";
  }
  /**
   * Calculate combined delivery window for today's packages.
   *
   * @param todayDeliveries Deliveries expected today
   */
  calculateCombinedWindow(todayDeliveries) {
    const windows = todayDeliveries.map((d) => this.calculateDeliveryWindow(d, this.parseStatus(d))).filter((w) => w.length > 0);
    if (windows.length === 0) {
      return "";
    }
    if (windows.length === 1) {
      return windows[0];
    }
    const times = [];
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
  async createAndSet(id, name, type, role, val) {
    await this.adapter.setObjectNotExistsAsync(id, {
      type: "state",
      common: { name, type, role, read: true, write: false },
      native: {}
    });
    await this.adapter.setStateAsync(id, { val, ack: true });
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  StateManager,
  resolveLanguage
});
//# sourceMappingURL=state-manager.js.map
