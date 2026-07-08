import { type AdapterInstance } from "@iobroker/adapter-core";
import { coerceFiniteNumber, oneLine } from "./coerce";
import { packageName, statusLabel, tName, tText } from "./i18n";
import type { ParcelDelivery, ParcelEvent } from "./types";
import { UNKNOWN_STATUS_CODE } from "./types";

/** Status codes that have expected delivery date/time: 2=In Transit, 4=Out for Delivery, 8=Info Received */
const TRACKABLE_STATUSES = new Set([2, 4, 8]);

/**
 * Upper bound for the `deliveries.*` object-view range query: the highest BMP
 * code unit, so the range covers every possible sanitized package id.
 */
const ID_RANGE_END = "￿";

/** Max length of a sanitized package-id segment (collision suffix handles truncation clashes). */
const MAX_ID_LENGTH = 50;

/**
 * v0.10.0 (I2): cap the parallel recursive deletes in cleanupDeliveries the
 * same way main.ts caps the update fan-out — a poll that suddenly loses many
 * packages must not flood the broker in one burst.
 */
const DELETE_BATCH_SIZE = 25;

/** Manages ioBroker states for parcel deliveries */
export class StateManager {
  private adapter: AdapterInstance;
  /**
   * Cache of state IDs that have already passed `setObjectNotExistsAsync`.
   * Skips repeat DB lookups on the hot path — each poll touches ~11 states
   * per delivery, and most deliveries see no schema change between polls.
   * On `cleanupDeliveries`, IDs of removed packages are dropped so a re-add
   * triggers a fresh creation.
   */
  private readonly createdIds = new Set<string>();

  /**
   * v0.10.0 (DP-5): package ids whose device object was ensured this process.
   * Replaces the former description+tracking signature map: with
   * `preserve: { common: ["name"] }` a rewrite never changed an existing
   * object's name anyway, so ensuring existence ONCE per process is the
   * honest version of what the signature cache actually did.
   */
  private readonly deviceEnsured = new Set<string>();

  /**
   * v0.7.2: package ids known to exist as device objects. Filled from the
   * object view ONCE after adapter start (reconciles leftovers from previous
   * runs), afterwards maintained in memory — `cleanupDeliveries` no longer
   * needs a DB round-trip per poll.
   */
  private knownDeliveryIds: Set<string> | null = null;

  /**
   * v0.4.2 (S3): which raw-tracking-key currently "owns" each sanitized id
   * within the running poll. Cleared via `resetPollState()` between polls so
   * the same delivery keeps its bare id as long as it's unique.
   */
  private readonly idOwner = new Map<string, string>();

  /**
   * @param adapter The ioBroker adapter instance
   */
  constructor(adapter: AdapterInstance) {
    this.adapter = adapter;
  }

  /**
   * Sanitize a string for use as ioBroker object ID (see adapter.FORBIDDEN_CHARS).
   * API-drift guard: returns "unknown" for non-string input.
   *
   * @param name Raw value to sanitize (any type)
   */
  sanitize(name: unknown): string {
    if (typeof name !== "string") {
      return "unknown";
    }
    return (
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, MAX_ID_LENGTH) || "unknown"
    );
  }

  /**
   * Parse the status code from a delivery. The API sends an int; we also accept
   * a numeric string and fall back to the "unknown" sentinel (-1) for drift.
   *
   * @param delivery The delivery to parse
   */
  parseStatus(delivery: ParcelDelivery): number {
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
    // API drift (non-numeric / non-string status_code). Return a visible
    // "unknown" sentinel instead of 0 (Delivered) — otherwise a garbage
    // status_code would silently filter the package out and remove it in
    // autoRemove mode. The active filter is `status !== 0`, so -1 stays visible.
    this.adapter.log.debug(
      `parseStatus drift: ${JSON.stringify(raw)} (type ${typeof raw}) → ${UNKNOWN_STATUS_CODE} (unknown, kept visible)`,
    );
    return UNKNOWN_STATUS_CODE;
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
  packageId(delivery: ParcelDelivery): string {
    let id = this.sanitize(delivery.tracking_number);
    // API-drift guard: only string values extend the id
    if (typeof delivery.extra_information === "string" && delivery.extra_information.length > 0) {
      id += `_${this.sanitize(delivery.extra_information)}`;
    }
    // v0.4.2 (S3): collision suffix when two distinct (raw) trackings would
    // collapse to the same id. Bare id is kept as long as it's unique
    // within this poll (back-compat with existing installs).
    const owner = this.idOwner.get(id);
    const rawKey = StateManager.rawIdKey(delivery);
    if (owner !== undefined && owner !== rawKey) {
      const suffixed = `${id}__${StateManager.shortHash(rawKey)}`;
      // v0.4.3 (C3): trace the collision-suffix path. Rare event but the
      // resulting state-id divergence is hard to diagnose without a log.
      this.adapter.log.debug(
        `packageId collision: bare='${id}' owner='${oneLine(owner)}' new='${oneLine(rawKey)}' → suffixed='${suffixed}'`,
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
  private static rawIdKey(delivery: ParcelDelivery): string {
    const t = typeof delivery.tracking_number === "string" ? delivery.tracking_number : "";
    const e = typeof delivery.extra_information === "string" ? delivery.extra_information : "";
    return `${t}\u0000${e}`;
  }

  /**
   * v0.4.2 (S3): FNV-1a 32-bit short hash → 6 hex chars.
   *
   * @param s Input string to hash.
   */
  private static shortHash(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0").slice(0, 6);
  }

  /**
   * v0.4.2 (S3): reset the per-poll collision tracker. Call from main.ts
   * before iterating deliveries so the bare id always wins for the first
   * occurrence in each poll.
   */
  resetPollState(): void {
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
  private static pkgIdOf(relativeId: string): string {
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
  async updateDelivery(delivery: ParcelDelivery, carrierName: string, pkgId: string): Promise<void> {
    const devicePath = `deliveries.${pkgId}`;

    const description = typeof delivery.description === "string" ? delivery.description : "";
    const trackingNumber = typeof delivery.tracking_number === "string" ? delivery.tracking_number : "";
    const extraInfo = typeof delivery.extra_information === "string" ? delivery.extra_information : "";

    // v0.10.0 (DP-5): ensure the device object once per process. `preserve:
    // name` keeps an existing name (user renames win), so the name — localized
    // fallback when the API sends no description (L18) — only matters at
    // first creation; the former per-change rewrite never had a visible effect.
    if (!this.deviceEnsured.has(pkgId)) {
      await this.adapter.extendObject(
        devicePath,
        {
          type: "device",
          common: {
            name: description || packageName(trackingNumber || pkgId),
          },
          native: {},
        },
        { preserve: { common: ["name"] } },
      );
      this.deviceEnsured.add(pkgId);
    }
    this.knownDeliveryIds?.add(pkgId);

    const statusCode = this.parseStatus(delivery);
    let statusText = statusLabel(statusCode);
    if (statusText === undefined) {
      // v0.4.3 (E3): trace unknown status-code (API drift). A future
      // parcel.app status (e.g. 9, 10) would render as "Unknown (N)"
      // without any log clue that the label table is out of date.
      this.adapter.log.debug(`status code ${statusCode} has no status_* label, using fallback`);
      statusText = `Unknown (${statusCode})`;
    }

    const deliveryWindow = this.calculateDeliveryWindow(delivery, statusCode);
    const deliveryEstimate = this.calculateDeliveryEstimate(delivery, statusCode);
    const lastEvent = this.formatLastEvent(delivery);
    const lastLocation = this.extractLastLocation(delivery);

    // v0.10.0 (M5): ONE definition list drives the writes AND the lastUpdated
    // decision — the former parallel JSON.stringify signature array was a
    // silent drift trap (a new field added to one list but not the other).
    const stateDefs: [
      id: string,
      name: ioBroker.StringOrTranslated,
      type: ioBroker.CommonType,
      role: string,
      val: ioBroker.StateValue,
    ][] = [
      [`${devicePath}.carrier`, tName("carrier"), "string", "text", carrierName],
      [`${devicePath}.status`, tName("status"), "string", "text", statusText],
      [`${devicePath}.statusCode`, tName("statusCode"), "number", "value", statusCode],
      [`${devicePath}.description`, tName("description"), "string", "text", description],
      [`${devicePath}.trackingNumber`, tName("trackingNumber"), "string", "text", trackingNumber],
      [`${devicePath}.extraInfo`, tName("extraInfo"), "string", "text", extraInfo],
      [`${devicePath}.deliveryWindow`, tName("deliveryWindow"), "string", "text", deliveryWindow],
      [`${devicePath}.deliveryEstimate`, tName("deliveryEstimate"), "string", "text", deliveryEstimate],
      [`${devicePath}.lastEvent`, tName("lastEvent"), "string", "text", lastEvent],
      [`${devicePath}.lastLocation`, tName("lastLocation"), "string", "text", lastLocation],
    ];
    const changed = await Promise.all(
      stateDefs.map(([id, name, type, role, val]) => this.createAndSet(id, name, type, role, val)),
    );

    // v0.10.0 (M5): `lastUpdated` = "when the tracking data last CHANGED".
    // The decision now rides on the broker's own setStateChanged answer
    // (notChanged=false ⇒ a sibling value really differed in the DB), so an
    // adapter restart no longer stamps every package with a fresh timestamp —
    // the old in-memory signature map always missed on the first poll after a
    // restart, and it was updated BEFORE its write survived (ASYNC-6).
    if (changed.some(Boolean)) {
      await this.createAndSet(
        `${devicePath}.lastUpdated`,
        tName("lastUpdated"),
        "string",
        "date",
        new Date().toISOString(),
      );
    }
  }

  /**
   * Update summary states. Expects already-filtered active deliveries.
   * The `summary` channel itself is declared via io-package.json instanceObjects.
   *
   * @param activeDeliveries Only active (non-delivered) deliveries
   */
  async updateSummary(activeDeliveries: ParcelDelivery[]): Promise<void> {
    const todayDeliveries = activeDeliveries.filter(d => this.isToday(d, this.parseStatus(d)));
    // v0.4.3 (E1): trace summary refresh — ~144/day at the default poll
    // interval, kept short (counts only).
    this.adapter.log.debug(
      `updateSummary: ${activeDeliveries.length} active, ${todayDeliveries.length} expected today`,
    );

    await Promise.all([
      this.createAndSet("summary.activeCount", tName("activeCount"), "number", "value", activeDeliveries.length),
      this.createAndSet("summary.todayCount", tName("todayCount"), "number", "value", todayDeliveries.length),
      this.createAndSet(
        "summary.deliveryWindow",
        tName("summaryDeliveryWindow"),
        "string",
        "text",
        this.calculateCombinedWindow(todayDeliveries),
      ),
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
  async cleanupDeliveries(keepIds: string[]): Promise<void> {
    // v0.7.2: the object view is queried only ONCE after adapter start to
    // reconcile leftovers from previous runs; afterwards the in-memory set
    // (maintained by updateDelivery + this prune) replaces the per-poll DB
    // round-trip.
    if (this.knownDeliveryIds === null) {
      const objects = await this.adapter.getObjectViewAsync("system", "device", {
        startkey: `${this.adapter.namespace}.deliveries.`,
        endkey: `${this.adapter.namespace}.deliveries.${ID_RANGE_END}`,
      });
      if (!objects?.rows) {
        // v0.4.3 (E2): trace the no-op path — happens on fresh installs or
        // when getObjectViewAsync returns falsy. Without this the early-return
        // is invisible (and the known-set stays unseeded for the next poll).
        this.adapter.log.debug("cleanupDeliveries: no objects view available, skipping");
        return;
      }
      this.knownDeliveryIds = new Set<string>();
      for (const row of objects.rows) {
        // The range query guarantees the namespace prefix — cut it instead of
        // pattern-replacing (v0.10.0, KISS-13).
        const pkgId = StateManager.pkgIdOf(row.id.slice(this.adapter.namespace.length + 1));
        if (pkgId) {
          this.knownDeliveryIds.add(pkgId);
        }
      }
    }

    const keepSet = new Set(keepIds);
    // v0.4.2 (S1): collect first, then delete in parallel — capped in batches
    // (v0.10.0, I2) like the update fan-out in main.ts.
    const toDelete = [...this.knownDeliveryIds].filter(pkgId => !keepSet.has(pkgId));
    const toDeleteSet = new Set(toDelete);

    for (let start = 0; start < toDelete.length; start += DELETE_BATCH_SIZE) {
      const batch = toDelete.slice(start, start + DELETE_BATCH_SIZE);
      await Promise.all(
        batch.map(async pkgId => {
          const relativeId = `deliveries.${pkgId}`;
          await this.adapter.delObjectAsync(relativeId, { recursive: true });
          this.adapter.log.debug(`Removed stale delivery: ${relativeId}`);
          this.deviceEnsured.delete(pkgId);
        }),
      );
    }

    // v0.9.0 (S2): prune createdIds for every removed package in ONE pass over
    // the set — O(created). A createdId is `deliveries.<pkgId>` or
    // `deliveries.<pkgId>.<state>` — extract the pkgId and drop it if removed.
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
  private static parseExpectedToMs(value: unknown): { ms: number; hasTime: boolean } | null {
    if (typeof value !== "string") {
      return null;
    }
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.trim());
    if (!m) {
      return null;
    }
    const hasClock = m[4] !== undefined;
    const year = Number(m[1]);
    const month = Number(m[2]); // 1-12
    const day = Number(m[3]);
    const hour = hasClock ? Number(m[4]) : 0;
    const min = hasClock ? Number(m[5]) : 0;
    const sec = m[6] !== undefined ? Number(m[6]) : 0;
    // Range-validate the components. The regex only checks digit COUNT, not
    // value range, and `new Date(2026, 12, 40, 25, …)` silently ROLLS OVER to a
    // wrong date (getTime() is NOT NaN). Reject out-of-range rather than guess.
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || min > 59 || sec > 59) {
      return null;
    }
    const date = new Date(year, month - 1, day, hour, min, sec);
    // Catch day-of-month overflow the range check misses (Feb 30, Apr 31, …):
    // a real date round-trips the month and day it was built from.
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
  private windowBoundsMs(delivery: ParcelDelivery, statusCode: number): { start: number; end: number | null } | null {
    if (!TRACKABLE_STATUSES.has(statusCode)) {
      return null;
    }
    const toMs = (timestamp: unknown): number | null => {
      const ts = coerceFiniteNumber(timestamp);
      if (ts === null || ts <= 0) {
        return null;
      }
      const ms = ts * 1000;
      return Number.isNaN(new Date(ms).getTime()) ? null : ms;
    };
    const dateMs = (value: unknown): number | null => {
      const parsed = StateManager.parseExpectedToMs(value);
      return parsed && parsed.hasTime ? parsed.ms : null;
    };
    const start = toMs(delivery.timestamp_expected) ?? dateMs(delivery.date_expected);
    if (start === null) {
      return null;
    }
    const end = toMs(delivery.timestamp_expected_end) ?? dateMs(delivery.date_expected_end);
    return { start, end };
  }

  /**
   * Format epoch-millis as local HH:MM.
   *
   * @param ms Epoch milliseconds
   */
  private static formatHHMM(ms: number): string {
    const d = new Date(ms);
    return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  }

  /**
   * Local "MM-DD HH:MM" — used when a window spans more than one calendar day.
   *
   * @param ms Epoch milliseconds
   */
  private static formatDateHHMM(ms: number): string {
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
  private static sameLocalDay(aMs: number, bMs: number): boolean {
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
  private static formatWindow(startMs: number, endMs: number | null): string {
    if (endMs === null || endMs <= startMs) {
      return StateManager.formatHHMM(startMs);
    }
    return StateManager.sameLocalDay(startMs, endMs)
      ? `${StateManager.formatHHMM(startMs)} - ${StateManager.formatHHMM(endMs)}`
      : `${StateManager.formatDateHHMM(startMs)} - ${StateManager.formatDateHHMM(endMs)}`;
  }

  /**
   * Calculate a delivery time-window string from the resolved expected bounds.
   *
   * @param delivery The delivery data
   * @param statusCode Pre-parsed status code
   */
  private calculateDeliveryWindow(delivery: ParcelDelivery, statusCode: number): string {
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
  private computeDiffDays(delivery: ParcelDelivery, statusCode: number): number | null {
    if (!TRACKABLE_STATUSES.has(statusCode)) {
      return null;
    }

    let expectedDate: Date | null = null;
    const ts = coerceFiniteNumber(delivery.timestamp_expected);
    if (ts !== null && ts > 0) {
      expectedDate = new Date(ts * 1000);
    } else {
      // Shares the window's date parser (one source of format-truth). Only the
      // calendar day matters here, so the time-of-day flag is ignored; the
      // local-component parse keeps the day timezone-stable.
      const parsed = StateManager.parseExpectedToMs(delivery.date_expected);
      expectedDate = parsed ? new Date(parsed.ms) : null;
    }

    if (!expectedDate || Number.isNaN(expectedDate.getTime())) {
      return null;
    }

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const expectedStart = new Date(expectedDate.getFullYear(), expectedDate.getMonth(), expectedDate.getDate());
    return Math.round((expectedStart.getTime() - todayStart.getTime()) / (1000 * 60 * 60 * 24));
  }

  /**
   * Calculate human-readable delivery estimate.
   *
   * @param delivery The delivery data
   * @param statusCode Pre-parsed status code
   */
  private calculateDeliveryEstimate(delivery: ParcelDelivery, statusCode: number): string {
    const diffDays = this.computeDiffDays(delivery, statusCode);
    if (diffDays === null) {
      return "";
    }
    if (diffDays < 0) {
      return tText("estimateOverdue");
    }
    if (diffDays === 0) {
      return tText("estimateToday");
    }
    if (diffDays === 1) {
      return tText("estimateTomorrow");
    }
    return tText("estimateDays", diffDays);
  }

  /**
   * Whether the delivery is expected today. Language-agnostic, used by the
   * summary filter so `todayCount` works across all languages.
   *
   * @param delivery The delivery data
   * @param statusCode Pre-parsed status code
   */
  private isToday(delivery: ParcelDelivery, statusCode: number): boolean {
    return this.computeDiffDays(delivery, statusCode) === 0;
  }

  private getLatestEvent(delivery: ParcelDelivery): ParcelEvent | null {
    if (!Array.isArray(delivery.events) || delivery.events.length === 0) {
      return null;
    }
    const latest = delivery.events[0];
    if (!latest || typeof latest !== "object") {
      return null;
    }
    return latest;
  }

  private formatLastEvent(delivery: ParcelDelivery): string {
    const latest = this.getLatestEvent(delivery);
    if (!latest) {
      return "";
    }
    const parts: string[] = [];
    if (typeof latest.event === "string" && latest.event.length > 0) {
      parts.push(latest.event);
    }
    if (typeof latest.date === "string" && latest.date.length > 0) {
      parts.push(latest.date);
    }
    return parts.join(" - ");
  }

  private extractLastLocation(delivery: ParcelDelivery): string {
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
  private calculateCombinedWindow(todayDeliveries: ParcelDelivery[]): string {
    const bounds = todayDeliveries
      .map(d => this.windowBoundsMs(d, this.parseStatus(d)))
      .filter((b): b is { start: number; end: number | null } => b !== null);

    if (bounds.length === 0) {
      return "";
    }

    const minStart = Math.min(...bounds.map(b => b.start));
    const maxEnd = Math.max(...bounds.map(b => b.end ?? b.start));
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
  private async createAndSet(
    id: string,
    name: ioBroker.StringOrTranslated,
    type: ioBroker.CommonType,
    role: string,
    val: ioBroker.StateValue,
  ): Promise<boolean> {
    if (!this.createdIds.has(id)) {
      await this.adapter.setObjectNotExistsAsync(id, {
        type: "state",
        common: { name, type, role, read: true, write: false },
        native: {},
      });
      this.createdIds.add(id);
    }
    // The bundled @iobroker/types 7.1.2 types this promise as `string`, but
    // js-controller ≥7.2.2 (our dependency floor) resolves { id, notChanged }
    // — verified at v7.2.2: adapter.ts invokes the callback with
    // (null, res.id, res.notChanged) and tools.promisify(['id','notChanged'])
    // builds the object from exactly these named args. Narrow locally instead
    // of trusting the stale published type.
    const result: unknown = await this.adapter.setStateChangedAsync(id, { val, ack: true });
    // Only an explicit notChanged=false counts as a write — anything else
    // (missing field, drifted runtime) must not fake "changed" on every poll.
    return typeof result === "object" && result !== null && (result as { notChanged?: unknown }).notChanged === false;
  }
}
