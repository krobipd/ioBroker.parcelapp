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
  StateManager: () => StateManager
});
module.exports = __toCommonJS(state_manager_exports);
var import_coerce = require("./coerce");
var import_i18n = require("./i18n");
var import_types = require("./types");
const TRACKABLE_STATUSES = /* @__PURE__ */ new Set([2, 4, 8]);
const ID_RANGE_END = "\uFFFF";
const MAX_ID_LENGTH = 50;
const DELETE_BATCH_SIZE = 25;
class StateManager {
  adapter;
  /**
   * Cache of state IDs that have already passed `setObjectNotExistsAsync`.
   * Skips repeat DB lookups on the hot path — each poll touches ~11 states
   * per delivery, and most deliveries see no schema change between polls.
   * On `cleanupDeliveries`, IDs of removed packages are dropped so a re-add
   * triggers a fresh creation.
   */
  createdIds = /* @__PURE__ */ new Set();
  /**
   * v0.10.0 (DP-5): package ids whose device object was ensured this process.
   * Replaces the former description+tracking signature map: with
   * `preserve: { common: ["name"] }` a rewrite never changed an existing
   * object's name anyway, so ensuring existence ONCE per process is the
   * honest version of what the signature cache actually did.
   */
  deviceEnsured = /* @__PURE__ */ new Set();
  /**
   * v0.7.2: package ids known to exist as device objects. Filled from the
   * object view ONCE after adapter start (reconciles leftovers from previous
   * runs), afterwards maintained in memory — `cleanupDeliveries` no longer
   * needs a DB round-trip per poll.
   */
  knownDeliveryIds = null;
  /**
   * v0.4.2 (S3): which raw-tracking-key currently "owns" each sanitized id
   * within the running poll. Cleared via `resetPollState()` between polls so
   * the same delivery keeps its bare id as long as it's unique.
   */
  idOwner = /* @__PURE__ */ new Map();
  /**
   * @param adapter The ioBroker adapter instance
   */
  constructor(adapter) {
    this.adapter = adapter;
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
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, MAX_ID_LENGTH) || "unknown";
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
        `packageId collision: bare='${id}' owner='${(0, import_coerce.oneLine)(owner)}' new='${(0, import_coerce.oneLine)(rawKey)}' \u2192 suffixed='${suffixed}'`
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
   * v0.4.2 (S3): reset the per-poll collision tracker. Call from main.ts
   * before iterating deliveries so the bare id always wins for the first
   * occurrence in each poll.
   */
  resetPollState() {
    this.idOwner.clear();
  }
  /**
   * Extract the package-id segment from a relative object id
   * (`deliveries.<pkgId>` or `deliveries.<pkgId>.<state>`); "" when the id is
   * outside the deliveries tree. Single source for the id-schema knowledge
   * (v0.10.0, L15).
   *
   * @param relativeId Object id relative to the adapter namespace
   */
  static pkgIdOf(relativeId) {
    return relativeId.startsWith("deliveries.") ? relativeId.slice("deliveries.".length).split(".")[0] : "";
  }
  /**
   * Update or create all states for a delivery.
   *
   * @param delivery The delivery data from API
   * @param carrierName Resolved carrier display name
   * @param pkgId Package id from the caller's deterministic pre-pass — always
   *   computed via `packageId()` so the collision suffixing stays deterministic
   *   (v0.10.0, L11: no test-only fallback path anymore).
   */
  async updateDelivery(delivery, carrierName, pkgId) {
    var _a;
    const devicePath = `deliveries.${pkgId}`;
    const description = typeof delivery.description === "string" ? delivery.description : "";
    const trackingNumber = typeof delivery.tracking_number === "string" ? delivery.tracking_number : "";
    const extraInfo = typeof delivery.extra_information === "string" ? delivery.extra_information : "";
    if (!this.deviceEnsured.has(pkgId)) {
      await this.adapter.extendObject(
        devicePath,
        {
          type: "device",
          common: {
            name: description || (0, import_i18n.packageName)(trackingNumber || pkgId)
          },
          native: {}
        },
        { preserve: { common: ["name"] } }
      );
      this.deviceEnsured.add(pkgId);
    }
    (_a = this.knownDeliveryIds) == null ? void 0 : _a.add(pkgId);
    const statusCode = this.parseStatus(delivery);
    let statusText = (0, import_i18n.statusLabel)(statusCode);
    if (statusText === void 0) {
      this.adapter.log.debug(`status code ${statusCode} has no status_* label, using fallback`);
      statusText = `Unknown (${statusCode})`;
    }
    const deliveryWindow = this.calculateDeliveryWindow(delivery, statusCode);
    const deliveryEstimate = this.calculateDeliveryEstimate(delivery, statusCode);
    const lastEvent = this.formatLastEvent(delivery);
    const lastLocation = this.extractLastLocation(delivery);
    const stateDefs = [
      [`${devicePath}.carrier`, (0, import_i18n.tName)("carrier"), "string", "text", carrierName],
      [`${devicePath}.status`, (0, import_i18n.tName)("status"), "string", "text", statusText],
      [`${devicePath}.statusCode`, (0, import_i18n.tName)("statusCode"), "number", "value", statusCode],
      [`${devicePath}.description`, (0, import_i18n.tName)("description"), "string", "text", description],
      [`${devicePath}.trackingNumber`, (0, import_i18n.tName)("trackingNumber"), "string", "text", trackingNumber],
      [`${devicePath}.extraInfo`, (0, import_i18n.tName)("extraInfo"), "string", "text", extraInfo],
      [`${devicePath}.deliveryWindow`, (0, import_i18n.tName)("deliveryWindow"), "string", "text", deliveryWindow],
      [`${devicePath}.deliveryEstimate`, (0, import_i18n.tName)("deliveryEstimate"), "string", "text", deliveryEstimate],
      [`${devicePath}.lastEvent`, (0, import_i18n.tName)("lastEvent"), "string", "text", lastEvent],
      [`${devicePath}.lastLocation`, (0, import_i18n.tName)("lastLocation"), "string", "text", lastLocation]
    ];
    const changed = await Promise.all(
      stateDefs.map(([id, name, type, role, val]) => this.createAndSet(id, name, type, role, val))
    );
    if (changed.some(Boolean)) {
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
   * Remove deliveries that are no longer present in the API response.
   *
   * @param keepIds Package IDs the API still returns this poll (kept). Every
   *   currently-known delivery NOT in this set is removed. The caller passes
   *   ALL visible package ids, not only the ones whose state-write succeeded —
   *   a transient write failure must not delete a still-present package.
   */
  async cleanupDeliveries(keepIds) {
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
        const pkgId = StateManager.pkgIdOf(row.id.slice(this.adapter.namespace.length + 1));
        if (pkgId) {
          this.knownDeliveryIds.add(pkgId);
        }
      }
    }
    const keepSet = new Set(keepIds);
    const toDelete = [...this.knownDeliveryIds].filter((pkgId) => !keepSet.has(pkgId));
    const toDeleteSet = new Set(toDelete);
    for (let start = 0; start < toDelete.length; start += DELETE_BATCH_SIZE) {
      const batch = toDelete.slice(start, start + DELETE_BATCH_SIZE);
      await Promise.all(
        batch.map(async (pkgId) => {
          const relativeId = `deliveries.${pkgId}`;
          await this.adapter.delObjectAsync(relativeId, { recursive: true });
          this.adapter.log.debug(`Removed stale delivery: ${relativeId}`);
          this.deviceEnsured.delete(pkgId);
        })
      );
    }
    if (toDeleteSet.size > 0) {
      for (const id of [...this.createdIds]) {
        if (toDeleteSet.has(StateManager.pkgIdOf(id))) {
          this.createdIds.delete(id);
        }
      }
    }
    this.knownDeliveryIds = new Set(keepSet);
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
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const hour = hasClock ? Number(m[4]) : 0;
    const min = hasClock ? Number(m[5]) : 0;
    const sec = m[6] !== void 0 ? Number(m[6]) : 0;
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || min > 59 || sec > 59) {
      return null;
    }
    const date = new Date(year, month - 1, day, hour, min, sec);
    if (Number.isNaN(date.getTime()) || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return null;
    }
    const hasTime = hasClock && !(hour === 0 && min === 0 && sec === 0);
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
   * Local "MM-DD HH:MM" — used when a window spans more than one calendar day.
   *
   * @param ms Epoch milliseconds
   */
  static formatDateHHMM(ms) {
    const d = new Date(ms);
    const mm = (d.getMonth() + 1).toString().padStart(2, "0");
    const dd = d.getDate().toString().padStart(2, "0");
    return `${mm}-${dd} ${StateManager.formatHHMM(ms)}`;
  }
  /**
   * Whether two epoch-millis fall on the same LOCAL calendar day.
   *
   * @param aMs First epoch milliseconds
   * @param bMs Second epoch milliseconds
   */
  static sameLocalDay(aMs, bMs) {
    const a = new Date(aMs);
    const b = new Date(bMs);
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }
  /**
   * Format a start→end window as a local string. A real end (> start) on the
   * SAME day renders "HH:MM - HH:MM"; an end on a LATER day carries the date on
   * both sides ("12-06 14:30 - 12-08 18:30") so a multi-day window is not shown
   * as if it were same-day. No end, or an end <= start (reversed/equal), renders
   * just the start.
   *
   * @param startMs Window start (epoch ms)
   * @param endMs Window end (epoch ms) or null
   */
  static formatWindow(startMs, endMs) {
    if (endMs === null || endMs <= startMs) {
      return StateManager.formatHHMM(startMs);
    }
    return StateManager.sameLocalDay(startMs, endMs) ? `${StateManager.formatHHMM(startMs)} - ${StateManager.formatHHMM(endMs)}` : `${StateManager.formatDateHHMM(startMs)} - ${StateManager.formatDateHHMM(endMs)}`;
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
    return StateManager.formatWindow(bounds.start, bounds.end);
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
    if (!expectedDate || Number.isNaN(expectedDate.getTime())) {
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
      return (0, import_i18n.tText)("estimateOverdue");
    }
    if (diffDays === 0) {
      return (0, import_i18n.tText)("estimateToday");
    }
    if (diffDays === 1) {
      return (0, import_i18n.tText)("estimateTomorrow");
    }
    return (0, import_i18n.tText)("estimateDays", diffDays);
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
    return StateManager.formatWindow(minStart, maxEnd);
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
   * @returns true when the broker actually wrote the value (it differed or the
   *   state was new) — the DB-backed "did anything change" signal driving
   *   `lastUpdated` (v0.10.0, M5)
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
    const result = await this.adapter.setStateChangedAsync(id, { val, ack: true });
    return typeof result === "object" && result !== null && result.notChanged === false;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  StateManager
});
//# sourceMappingURL=state-manager.js.map
