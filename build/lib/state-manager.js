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
var import_adapter_core = require("@iobroker/adapter-core");
var import_coerce = require("./coerce");
var import_i18n = require("./i18n");
var import_types = require("./types");
const TRACKABLE_STATUSES = /* @__PURE__ */ new Set([2, 4, 8]);
const ID_RANGE_END = "\uFFFF";
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
   * v0.7.2: last-written device-object signature per package id (the name
   * source: description + tracking number). `updateDelivery` used to
   * extendObject the device on EVERY poll — one object write + objectChange
   * event per package per minute for data that practically never changes.
   * Now the write happens only when the signature differs.
   */
  deviceWritten = /* @__PURE__ */ new Map();
  /**
   * v0.7.2: signature of the last-written state values per package id.
   * `lastUpdated` is only refreshed when at least one sibling value actually
   * changed — before, a fresh ISO timestamp fired one guaranteed state event
   * per package per poll, defeating the v0.5.3 skip-unchanged optimization
   * for that state. Semantics: `lastUpdated` = "when the tracking data last
   * changed", not "when the adapter last polled".
   */
  valuesSig = /* @__PURE__ */ new Map();
  /**
   * v0.7.2: package ids known to exist as device objects. Filled from the
   * object view ONCE after adapter start (reconciles leftovers from previous
   * runs), afterwards maintained in memory — `cleanupDeliveries` no longer
   * needs a DB round-trip per poll.
   */
  knownDeliveryIds = null;
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
   * Parse the status code from a delivery. The API sends an int; we also accept
   * a numeric string and fall back to the "unknown" sentinel (-1) for drift.
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
      if (Number.isFinite(n)) {
        return n;
      }
    }
    this.adapter.log.debug(
      `parseStatus drift: ${JSON.stringify(raw)} (type ${typeof raw}) \u2192 ${import_types.UNKNOWN_STATUS_CODE} (unknown, kept visible)`
    );
    return import_types.UNKNOWN_STATUS_CODE;
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
      this.adapter.log.debug(
        `packageId collision: bare='${id}' owner='${owner}' new='${rawKey}' \u2192 suffixed='${suffixed}'`
      );
      this.idOwner.set(suffixed, rawKey);
      return suffixed;
    }
    this.idOwner.set(id, rawKey);
    return id;
  }
  /**
   * v0.4.2 (S3): build a stable raw-key for collision tracking.
   *
   * @param delivery The delivery whose raw tracking identifies it.
   */
  static rawIdKey(delivery) {
    const t = typeof delivery.tracking_number === "string" ? delivery.tracking_number : "";
    const e = typeof delivery.extra_information === "string" ? delivery.extra_information : "";
    return `${t}\0${e}`;
  }
  /**
   * v0.4.2 (S3): FNV-1a 32-bit short hash → 6 hex chars.
   *
   * @param s Input string to hash.
   */
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
   * @param precomputedId Optional package id from the caller's deterministic
   *   pre-pass. Falls back to computing it here when called directly (tests).
   */
  async updateDelivery(delivery, carrierName, precomputedId) {
    var _a;
    const pkgId = precomputedId != null ? precomputedId : this.packageId(delivery);
    const devicePath = `deliveries.${pkgId}`;
    const description = typeof delivery.description === "string" ? delivery.description : "";
    const trackingNumber = typeof delivery.tracking_number === "string" ? delivery.tracking_number : "";
    const extraInfo = typeof delivery.extra_information === "string" ? delivery.extra_information : "";
    const deviceSig = `${description} ${trackingNumber}`;
    if (this.deviceWritten.get(pkgId) !== deviceSig) {
      await this.adapter.extendObjectAsync(
        devicePath,
        {
          type: "device",
          common: {
            name: description || `Package ${trackingNumber || pkgId}`
          },
          native: {}
        },
        { preserve: { common: ["name"] } }
      );
      this.deviceWritten.set(pkgId, deviceSig);
    }
    (_a = this.knownDeliveryIds) == null ? void 0 : _a.add(pkgId);
    const statusCode = this.parseStatus(delivery);
    const labels = import_types.STATUS_LABELS[this.language];
    let statusText = labels[statusCode];
    if (!statusText) {
      this.adapter.log.debug(`status code ${statusCode} not in STATUS_LABELS[${this.language}], using fallback`);
      statusText = `Unknown (${statusCode})`;
    }
    const deliveryWindow = this.calculateDeliveryWindow(delivery, statusCode);
    const deliveryEstimate = this.calculateDeliveryEstimate(delivery, statusCode);
    const lastEvent = this.formatLastEvent(delivery);
    const lastLocation = this.extractLastLocation(delivery);
    await Promise.all([
      this.createAndSet(`${devicePath}.carrier`, (0, import_i18n.tName)("carrier"), "string", "text", carrierName),
      this.createAndSet(`${devicePath}.status`, (0, import_i18n.tName)("status"), "string", "text", statusText),
      this.createAndSet(`${devicePath}.statusCode`, (0, import_i18n.tName)("statusCode"), "number", "value", statusCode),
      this.createAndSet(`${devicePath}.description`, (0, import_i18n.tName)("description"), "string", "text", description),
      this.createAndSet(`${devicePath}.trackingNumber`, (0, import_i18n.tName)("trackingNumber"), "string", "text", trackingNumber),
      this.createAndSet(`${devicePath}.extraInfo`, (0, import_i18n.tName)("extraInfo"), "string", "text", extraInfo),
      this.createAndSet(`${devicePath}.deliveryWindow`, (0, import_i18n.tName)("deliveryWindow"), "string", "text", deliveryWindow),
      this.createAndSet(
        `${devicePath}.deliveryEstimate`,
        (0, import_i18n.tName)("deliveryEstimate"),
        "string",
        "text",
        deliveryEstimate
      ),
      this.createAndSet(`${devicePath}.lastEvent`, (0, import_i18n.tName)("lastEvent"), "string", "text", lastEvent),
      this.createAndSet(`${devicePath}.lastLocation`, (0, import_i18n.tName)("lastLocation"), "string", "text", lastLocation)
    ]);
    const sig = JSON.stringify([
      carrierName,
      statusText,
      statusCode,
      description,
      trackingNumber,
      extraInfo,
      deliveryWindow,
      deliveryEstimate,
      lastEvent,
      lastLocation
    ]);
    if (this.valuesSig.get(pkgId) !== sig) {
      this.valuesSig.set(pkgId, sig);
      await this.createAndSet(
        `${devicePath}.lastUpdated`,
        (0, import_i18n.tName)("lastUpdated"),
        "string",
        "date",
        (/* @__PURE__ */ new Date()).toISOString()
      );
    }
  }
  /**
   * Update summary states. Expects already-filtered active deliveries.
   * The `summary` channel itself is declared via io-package.json instanceObjects.
   *
   * @param activeDeliveries Only active (non-delivered) deliveries
   */
  async updateSummary(activeDeliveries) {
    const todayDeliveries = activeDeliveries.filter((d) => this.isToday(d, this.parseStatus(d)));
    this.adapter.log.debug(
      `updateSummary: ${activeDeliveries.length} active, ${todayDeliveries.length} expected today`
    );
    await Promise.all([
      this.createAndSet("summary.activeCount", (0, import_i18n.tName)("activeCount"), "number", "value", activeDeliveries.length),
      this.createAndSet("summary.todayCount", (0, import_i18n.tName)("todayCount"), "number", "value", todayDeliveries.length),
      this.createAndSet(
        "summary.deliveryWindow",
        (0, import_i18n.tName)("summaryDeliveryWindow"),
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
    if (this.knownDeliveryIds === null) {
      const objects = await this.adapter.getObjectViewAsync("system", "device", {
        startkey: `${this.adapter.namespace}.deliveries.`,
        endkey: `${this.adapter.namespace}.deliveries.${ID_RANGE_END}`
      });
      if (!(objects == null ? void 0 : objects.rows)) {
        this.adapter.log.debug("cleanupDeliveries: no objects view available, skipping");
        return;
      }
      this.knownDeliveryIds = /* @__PURE__ */ new Set();
      for (const row of objects.rows) {
        const relativeId = row.id.replace(`${this.adapter.namespace}.`, "");
        if (relativeId.startsWith("deliveries.")) {
          const pkgId = relativeId.slice("deliveries.".length).split(".")[0];
          if (pkgId) {
            this.knownDeliveryIds.add(pkgId);
          }
        }
      }
    }
    const activeSet = new Set(activeIds);
    const toDelete = [...this.knownDeliveryIds].filter((pkgId) => !activeSet.has(pkgId));
    await Promise.all(
      toDelete.map(async (pkgId) => {
        const relativeId = `deliveries.${pkgId}`;
        await this.adapter.delObjectAsync(relativeId, { recursive: true });
        this.adapter.log.debug(`Removed stale delivery: ${relativeId}`);
        this.deviceWritten.delete(pkgId);
        this.valuesSig.delete(pkgId);
        for (const id of [...this.createdIds]) {
          if (id === relativeId || id.startsWith(`${relativeId}.`)) {
            this.createdIds.delete(id);
          }
        }
      })
    );
    this.knownDeliveryIds = new Set(activeSet);
  }
  /**
   * Parse a parcel.app expected-date string to LOCAL epoch-millis.
   *
   * The API delivers `date_expected`/`date_expected_end` "without specific
   * timezone information"; parse with explicit local calendar components so the
   * value lands on the intended local day/time (`new Date("YYYY-MM-DD")` would
   * be UTC midnight). `hasTime` is false for a bare date or a midnight time
   * (a day, not an hour-window). Ambiguous carrier formats (dotted, weekday
   * names) are deliberately NOT guessed — they return null rather than risk a
   * wrong date.
   *
   * @param value Raw date/time string from the API
   */
  static parseExpectedToMs(value) {
    if (typeof value !== "string") {
      return null;
    }
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.trim());
    if (!m) {
      return null;
    }
    const hasClock = m[4] !== void 0;
    const date = new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      hasClock ? Number(m[4]) : 0,
      hasClock ? Number(m[5]) : 0,
      m[6] !== void 0 ? Number(m[6]) : 0
    );
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    const hasTime = hasClock && !(Number(m[4]) === 0 && Number(m[5]) === 0 && (m[6] === void 0 || Number(m[6]) === 0));
    return { ms: date.getTime(), hasTime };
  }
  /**
   * Resolve a delivery's expected window to epoch-millis bounds. Returns null
   * for non-trackable status or when there is no usable start time.
   *
   * Prefers the Unix timestamp fields; for carriers that report the window only
   * as a date/time string (`date_expected`/`date_expected_end`) it falls back to
   * those — but only when the string carries a real time-of-day (a bare date or
   * midnight is a day, not an hour-window). Carrier-agnostic.
   *
   * @param delivery The delivery data
   * @param statusCode Pre-parsed status code
   */
  windowBoundsMs(delivery, statusCode) {
    var _a, _b;
    if (!TRACKABLE_STATUSES.has(statusCode)) {
      return null;
    }
    const toMs = (timestamp) => {
      const ts = (0, import_coerce.coerceFiniteNumber)(timestamp);
      if (ts === null || ts <= 0) {
        return null;
      }
      const ms = ts * 1e3;
      return Number.isNaN(new Date(ms).getTime()) ? null : ms;
    };
    const dateMs = (value) => {
      const parsed = StateManager.parseExpectedToMs(value);
      return parsed && parsed.hasTime ? parsed.ms : null;
    };
    const start = (_a = toMs(delivery.timestamp_expected)) != null ? _a : dateMs(delivery.date_expected);
    if (start === null) {
      return null;
    }
    const end = (_b = toMs(delivery.timestamp_expected_end)) != null ? _b : dateMs(delivery.date_expected_end);
    return { start, end };
  }
  /**
   * Format epoch-millis as local HH:MM.
   *
   * @param ms Epoch milliseconds
   */
  static formatHHMM(ms) {
    const d = new Date(ms);
    return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  }
  /**
   * Calculate a delivery time-window string from the resolved expected bounds.
   *
   * @param delivery The delivery data
   * @param statusCode Pre-parsed status code
   */
  calculateDeliveryWindow(delivery, statusCode) {
    const bounds = this.windowBoundsMs(delivery, statusCode);
    if (!bounds) {
      return "";
    }
    const start = StateManager.formatHHMM(bounds.start);
    return bounds.end !== null ? `${start} - ${StateManager.formatHHMM(bounds.end)}` : start;
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
    } else {
      const parsed = StateManager.parseExpectedToMs(delivery.date_expected);
      expectedDate = parsed ? new Date(parsed.ms) : null;
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
    if (diffDays < 0) {
      return import_adapter_core.I18n.translate("estimateOverdue");
    }
    if (diffDays === 0) {
      return import_adapter_core.I18n.translate("estimateToday");
    }
    if (diffDays === 1) {
      return import_adapter_core.I18n.translate("estimateTomorrow");
    }
    return import_adapter_core.I18n.translate("estimateDays").replace("%d", String(diffDays));
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
  getLatestEvent(delivery) {
    if (!Array.isArray(delivery.events) || delivery.events.length === 0) {
      return null;
    }
    const latest = delivery.events[0];
    if (!latest || typeof latest !== "object") {
      return null;
    }
    return latest;
  }
  formatLastEvent(delivery) {
    const latest = this.getLatestEvent(delivery);
    if (!latest) {
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
  extractLastLocation(delivery) {
    const latest = this.getLatestEvent(delivery);
    if (!latest) {
      return "";
    }
    return typeof latest.location === "string" ? latest.location : "";
  }
  /**
   * Combined delivery window for today's packages: earliest start to latest
   * end across all windows. Computed from the raw millis (not the formatted
   * strings) so the latest end always wins — fixes the earlier bug where the
   * end of the latest-*starting* window was used instead of the maximum end.
   *
   * @param todayDeliveries Deliveries expected today
   */
  calculateCombinedWindow(todayDeliveries) {
    const bounds = todayDeliveries.map((d) => this.windowBoundsMs(d, this.parseStatus(d))).filter((b) => b !== null);
    if (bounds.length === 0) {
      return "";
    }
    const minStart = Math.min(...bounds.map((b) => b.start));
    const maxEnd = Math.max(...bounds.map((b) => {
      var _a;
      return (_a = b.end) != null ? _a : b.start;
    }));
    const startStr = StateManager.formatHHMM(minStart);
    return maxEnd > minStart ? `${startStr} - ${StateManager.formatHHMM(maxEnd)}` : startStr;
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
    await this.adapter.setStateChangedAsync(id, { val, ack: true });
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  StateManager,
  resolveLanguage
});
//# sourceMappingURL=state-manager.js.map
