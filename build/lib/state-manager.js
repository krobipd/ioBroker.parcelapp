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
var import_coerce = require("./coerce");
var import_i18n_states = require("./i18n-states");
var import_types = require("./types");
const TRACKABLE_STATUSES = /* @__PURE__ */ new Set([2, 4, 8]);
function asName(name) {
  return name;
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
   * Cache of state IDs that have already passed `setObjectNotExistsAsync`.
   * Skips repeat DB lookups on the hot path — each poll touches ~11 states
   * per delivery, and most deliveries see no schema change between polls.
   * On `cleanupDeliveries`, IDs of removed packages are dropped so a re-add
   * triggers a fresh creation.
   */
  createdIds = /* @__PURE__ */ new Set();
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
   * v0.4.2 (S3): when the bare `sanitize(tracking_number)` collides with
   * another active package (e.g. two trackings differ only in special
   * chars that strip down to the same id), append a stable hash of the
   * full tracking number so both end up at distinct state IDs.
   *
   * @param delivery The delivery to build an ID for
   */
  packageId(delivery) {
    let id = this.sanitize(delivery.tracking_number);
    if (typeof delivery.extra_information === "string" && delivery.extra_information.length > 0) {
      id += `_${this.sanitize(delivery.extra_information)}`;
    }
    const owner = this.idOwner.get(id);
    const rawKey = StateManager.rawIdKey(delivery);
    if (owner !== void 0 && owner !== rawKey) {
      const suffixed = `${id}__${StateManager.shortHash(rawKey)}`;
      this.idOwner.set(suffixed, rawKey);
      return suffixed;
    }
    this.idOwner.set(id, rawKey);
    return id;
  }
  /** v0.4.2 (S3): build a stable raw-key for collision tracking. */
  static rawIdKey(delivery) {
    const t = typeof delivery.tracking_number === "string" ? delivery.tracking_number : "";
    const e = typeof delivery.extra_information === "string" ? delivery.extra_information : "";
    return `${t}\0${e}`;
  }
  /** v0.4.2 (S3): FNV-1a 32-bit short hash → 6 hex chars. */
  static shortHash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, "0").slice(0, 6);
  }
  /**
   * v0.4.2 (S3): which raw-tracking-key currently "owns" each sanitized id
   * within the running poll. Cleared via `resetIdOwners()` between polls so
   * the same delivery keeps its bare id as long as it's unique.
   */
  idOwner = /* @__PURE__ */ new Map();
  /**
   * v0.4.2 (S3): reset the per-poll collision tracker. Call from main.ts
   * before iterating deliveries so the bare id always wins for the first
   * occurrence in each poll.
   */
  resetPollState() {
    this.idOwner.clear();
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
      this.createAndSet(`${devicePath}.carrier`, asName((0, import_i18n_states.tName)("carrier")), "string", "text", carrierName),
      this.createAndSet(`${devicePath}.status`, asName((0, import_i18n_states.tName)("status")), "string", "text", statusText),
      this.createAndSet(`${devicePath}.statusCode`, asName((0, import_i18n_states.tName)("statusCode")), "number", "value", statusCode),
      this.createAndSet(`${devicePath}.description`, asName((0, import_i18n_states.tName)("description")), "string", "text", description),
      this.createAndSet(
        `${devicePath}.trackingNumber`,
        asName((0, import_i18n_states.tName)("trackingNumber")),
        "string",
        "text",
        trackingNumber
      ),
      this.createAndSet(`${devicePath}.extraInfo`, asName((0, import_i18n_states.tName)("extraInfo")), "string", "text", extraInfo),
      this.createAndSet(
        `${devicePath}.deliveryWindow`,
        asName((0, import_i18n_states.tName)("deliveryWindow")),
        "string",
        "text",
        this.calculateDeliveryWindow(delivery, statusCode)
      ),
      this.createAndSet(
        `${devicePath}.deliveryEstimate`,
        asName((0, import_i18n_states.tName)("deliveryEstimate")),
        "string",
        "text",
        this.calculateDeliveryEstimate(delivery, statusCode)
      ),
      this.createAndSet(
        `${devicePath}.lastEvent`,
        asName((0, import_i18n_states.tName)("lastEvent")),
        "string",
        "text",
        this.formatLastEvent(delivery)
      ),
      this.createAndSet(
        `${devicePath}.lastLocation`,
        asName((0, import_i18n_states.tName)("lastLocation")),
        "string",
        "text",
        this.extractLastLocation(delivery)
      ),
      this.createAndSet(
        `${devicePath}.lastUpdated`,
        asName((0, import_i18n_states.tName)("lastUpdated")),
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
    const todayDeliveries = activeDeliveries.filter((d) => this.isToday(d, this.parseStatus(d)));
    await Promise.all([
      this.createAndSet(
        "summary.activeCount",
        asName((0, import_i18n_states.tName)("activeCount")),
        "number",
        "value",
        activeDeliveries.length
      ),
      this.createAndSet("summary.todayCount", asName((0, import_i18n_states.tName)("todayCount")), "number", "value", todayDeliveries.length),
      this.createAndSet(
        "summary.deliveryWindow",
        asName((0, import_i18n_states.tName)("summaryDeliveryWindow")),
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
    if (!(objects == null ? void 0 : objects.rows)) {
      return;
    }
    const toDelete = [];
    for (const row of objects.rows) {
      const relativeId = row.id.replace(`${this.adapter.namespace}.`, "");
      if (relativeId.startsWith("deliveries.") && !activeSet.has(relativeId)) {
        toDelete.push(relativeId);
      }
    }
    await Promise.all(
      toDelete.map(async (relativeId) => {
        await this.adapter.delObjectAsync(relativeId, { recursive: true });
        this.adapter.log.debug(`Removed stale delivery: ${relativeId}`);
        for (const id of [...this.createdIds]) {
          if (id === relativeId || id.startsWith(`${relativeId}.`)) {
            this.createdIds.delete(id);
          }
        }
      })
    );
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
      const ts = (0, import_coerce.coerceFiniteNumber)(timestamp);
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
    const ts = (0, import_coerce.coerceFiniteNumber)(delivery.timestamp_expected);
    if (ts !== null && ts > 0) {
      expectedDate = new Date(ts * 1e3);
    } else if (typeof delivery.date_expected === "string" && delivery.date_expected.length > 0) {
      expectedDate = new Date(delivery.date_expected);
    }
    if (!expectedDate || isNaN(expectedDate.getTime())) {
      return null;
    }
    const now = /* @__PURE__ */ new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const expectedStart = new Date(expectedDate.getFullYear(), expectedDate.getMonth(), expectedDate.getDate());
    return Math.round((expectedStart.getTime() - todayStart.getTime()) / (1e3 * 60 * 60 * 24));
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
   * Create/extend a read-only state and set its value. Skips the
   * `setObjectNotExistsAsync` round-trip once the ID is in the cache —
   * states are static after first creation; only the value changes per poll.
   *
   * @param id State ID relative to adapter namespace
   * @param name Display name (translation object or plain string)
   * @param type Value type
   * @param role ioBroker role
   * @param val Value to set
   */
  async createAndSet(id, name, type, role, val) {
    if (!this.createdIds.has(id)) {
      await this.adapter.setObjectNotExistsAsync(id, {
        type: "state",
        common: { name, type, role, read: true, write: false },
        native: {}
      });
      this.createdIds.add(id);
    }
    await this.adapter.setStateAsync(id, { val, ack: true });
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  StateManager,
  resolveLanguage
});
//# sourceMappingURL=state-manager.js.map
