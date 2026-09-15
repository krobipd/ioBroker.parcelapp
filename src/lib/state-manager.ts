import { type AdapterInstance } from "@iobroker/adapter-core";
import { errText, oneLine } from "./coerce";
import {
  calculateCombinedWindow,
  calculateDeliveryEstimate,
  calculateDeliveryWindow,
  extractLastLocation,
  formatLastEvent,
  isToday,
  type DriftLogger,
  type StatusedDelivery,
} from "./delivery-view";
import { packageName, statusLabel, tName } from "./i18n";
import type { ParcelDelivery } from "./types";
import { UNKNOWN_STATUS_CODE } from "./types";

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
   * Cache of state IDs whose object has already been written this process.
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
   * L1: per-delivery-object memo for `parseStatus`. A poll parses the SAME
   * delivery object at several sites (main's active filter, updateDelivery,
   * updateSummary's pre-pass); memoizing keyed by the object means the parse —
   * and its drift debug line — runs ONCE per delivery
   * instead of per site. No reset needed: each poll's deliveries are fresh
   * objects (JSON.parse) and GC'd afterwards, and nothing holds a long-lived
   * delivery reference (idOwner/failedDeliveries/knownDeliveryIds store strings).
   */
  private readonly statusMemo = new WeakMap<ParcelDelivery, number>();

  /**
   * v0.12.0 (B2): raw date values already reported as drift during this poll. The same
   * unparseable string is seen up to four times per poll (window, estimate, today filter,
   * combined window); without this the log would carry four identical lines per package. Cleared
   * in `resetPollState()`, the same way the collision tracker is.
   */
  private readonly driftReported = new Set<string>();

  /**
   * Trace sink handed to `delivery-view`: one debug line per distinct drift message per poll.
   * The parser itself stays pure — the de-duplication lives here, next to the poll lifecycle
   * that defines the window.
   */
  private readonly viewLog: DriftLogger = {
    debug: (message: string): void => {
      if (this.driftReported.has(message)) {
        return;
      }
      this.driftReported.add(message);
      this.adapter.log.debug(message);
    },
  };

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
    // L1: memoize per delivery object so the parse (and its drift log) runs
    // once per delivery per poll, not once per call site.
    const memoized = this.statusMemo.get(delivery);
    if (memoized !== undefined) {
      return memoized;
    }
    const code = this.computeStatus(delivery);
    this.statusMemo.set(delivery, code);
    return code;
  }

  /**
   * Parse the status code without memoization. Split from {@link parseStatus}
   * (L1) so the memo wraps a single pure computation — including the one-per-
   * delivery drift log.
   *
   * @param delivery The delivery to parse
   */
  private computeStatus(delivery: ParcelDelivery): number {
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
      const suffixed = `${id}__${StateManager.shortHash(StateManager.suffixKey(delivery))}`;
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
    // v0.13.0 (audit S1): the carrier belongs to a delivery's IDENTITY. Without it
    // the same tracking number under two carriers produced one identical key, so
    // `packageId` saw no collision, both deliveries mapped to one state id and one
    // of the two packages was invisible in ioBroker — silently, with the keep-set
    // holding a single entry for both. The realistic path: a number added with the
    // wrong carrier (the API has no DELETE) and then added again correctly.
    const c = typeof delivery.carrier_code === "string" ? delivery.carrier_code : "";
    return `${t}\u0000${e}\u0000${c}`;
  }

  /**
   * v0.13.0: the material of the collision SUFFIX — deliberately without the
   * carrier. The suffix is part of a state id that exists on installations, and
   * feeding the carrier into the hash would rename those objects (a rename means
   * delete + create, taking the user's recording settings with it). Identity and
   * suffix material are therefore two functions.
   *
   * @param delivery The delivery whose suffix material is built.
   */
  private static suffixKey(delivery: ParcelDelivery): string {
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
   * v0.4.2 (S3): reset the per-poll drift dedup. Call from main.ts before
   * iterating deliveries.
   *
   * v0.13.0 (audit S1b): the collision tracker is NOT cleared any more. It used
   * to be, so the bare id went to whichever colliding delivery came first in the
   * API's array — an order the API does not document. Two colliding packages
   * could therefore swap their state ids between two polls. The owner now keeps
   * the bare id for as long as it is present; `cleanupDeliveries` releases the
   * entry when the package is gone, and the other one moves up on the next poll.
   */
  resetPollState(): void {
    this.driftReported.clear();
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

    const deliveryWindow = calculateDeliveryWindow(delivery, statusCode, this.viewLog);
    const deliveryEstimate = calculateDeliveryEstimate(delivery, statusCode, this.viewLog);
    const lastEvent = formatLastEvent(delivery);
    const lastLocation = extractLastLocation(delivery);

    // v0.10.0 (M5): ONE definition list drives the writes AND the lastUpdated
    // decision — the former parallel JSON.stringify signature array was a
    // silent drift trap (a new field added to one list but not the other).
    // `desc` is an EXPLANATION, only where the name alone does not give it —
    // `undefined` means "nothing to explain here", and an invented sentence
    // would be worse than none (fleet standard, 2026-09-02). Every `undefined`
    // here needs its counterpart in `test/self-explaining.json`, which is where
    // the fleet gate D08 reads the decision (2026-09-07).
    const stateDefs: [
      id: string,
      name: ioBroker.StringOrTranslated,
      type: ioBroker.CommonType,
      role: string,
      val: ioBroker.StateValue,
      desc: ioBroker.StringOrTranslated | undefined,
    ][] = [
      [`${devicePath}.carrier`, tName("carrier"), "string", "text", carrierName, tName("descCarrier")],
      [`${devicePath}.status`, tName("status"), "string", "text", statusText, tName("descStatus")],
      [`${devicePath}.statusCode`, tName("statusCode"), "number", "value", statusCode, tName("descStatusCode")],
      [`${devicePath}.description`, tName("description"), "string", "text", description, tName("descDescription")],
      [`${devicePath}.trackingNumber`, tName("trackingNumber"), "string", "text", trackingNumber, undefined],
      [`${devicePath}.extraInfo`, tName("extraInfo"), "string", "text", extraInfo, tName("descExtraInfo")],
      [
        `${devicePath}.deliveryWindow`,
        tName("deliveryWindow"),
        "string",
        "text",
        deliveryWindow,
        tName("descDeliveryWindow"),
      ],
      [
        `${devicePath}.deliveryEstimate`,
        tName("deliveryEstimate"),
        "string",
        "text",
        deliveryEstimate,
        tName("descDeliveryEstimate"),
      ],
      [`${devicePath}.lastEvent`, tName("lastEvent"), "string", "text", lastEvent, tName("descLastEvent")],
      [`${devicePath}.lastLocation`, tName("lastLocation"), "string", "text", lastLocation, tName("descLastLocation")],
    ];
    const changed = await Promise.all(
      stateDefs.map(([id, name, type, role, val, desc]) => this.createAndSet(id, name, type, role, val, desc)),
    );

    // v0.10.0 (M5): `lastUpdated` = "when the tracking data last CHANGED".
    // The decision now rides on the broker's own setStateChanged answer
    // (notChanged=false ⇒ a sibling value really differed in the DB), so an
    // adapter restart no longer stamps every package with a fresh timestamp —
    // the old in-memory signature map always missed on the first poll after a
    // restart, and it was updated BEFORE its write survived (ASYNC-6).
    // The OBJECT is refreshed on every poll cycle (once per process, the cache sees to that) —
    // only the VALUE stays behind the change condition. Welding the two together left this
    // datapoint with a stale `common` forever on a quiet installation (v0.11.1).
    await this.ensureStateObject(
      `${devicePath}.lastUpdated`,
      tName("lastUpdated"),
      "string",
      "date",
      tName("descLastUpdated"),
    );
    if (changed.some(Boolean)) {
      // No `desc` argument here on purpose: ensureStateObject above already wrote the object and
      // put the id in the cache, so anything passed along would be dead weight.
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
    // Parse the status ONCE per delivery here and carry it along — the today filter and the
    // combined window both need it, and `calculateCombinedWindow` no longer has to reach back
    // into the state manager for it (v0.12.0).
    const statused: StatusedDelivery[] = activeDeliveries.map(d => ({
      delivery: d,
      statusCode: this.parseStatus(d),
    }));
    const todayDeliveries = statused.filter(e => isToday(e.delivery, e.statusCode, this.viewLog));
    // v0.4.3 (E1): trace summary refresh — ~144/day at the default poll
    // interval, kept short (counts only).
    this.adapter.log.debug(
      `updateSummary: ${activeDeliveries.length} active, ${todayDeliveries.length} expected today`,
    );

    await Promise.all([
      this.createAndSet(
        "summary.activeCount",
        tName("activeCount"),
        "number",
        "value",
        activeDeliveries.length,
        tName("descActiveCount"),
      ),
      this.createAndSet(
        "summary.todayCount",
        tName("todayCount"),
        "number",
        "value",
        todayDeliveries.length,
        tName("descTodayCount"),
      ),
      this.createAndSet(
        "summary.deliveryWindow",
        tName("summaryDeliveryWindow"),
        "string",
        "text",
        calculateCombinedWindow(todayDeliveries, this.viewLog),
        tName("descSummaryDeliveryWindow"),
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

    // v0.12.0: a delete that FAILED must change nothing, and a delete that landed must clear
    // EVERY cache in the same step. Before this, `deviceEnsured` was pruned inside the loop while
    // the `createdIds` prune sat after it — one rejecting `delObjectAsync` aborted the `Promise.all`,
    // so the second prune never ran. A package that came back afterwards had its device object
    // re-created but NOT its state objects (`ensureStateObject` still found them in `createdIds`),
    // while `createAndSet` wrote the values anyway: datapoints without name, type, role or
    // description — for the rest of the process, measured over four polls without healing.
    // `allSettled` instead of `all` for the same reason: one broker failure must not cancel the
    // remaining deletes of this poll.
    const deleted = new Set<string>();
    // Kept as a real Error: it is re-thrown below, and a rejected promise may carry anything.
    let deleteError: Error | undefined;
    for (let start = 0; start < toDelete.length; start += DELETE_BATCH_SIZE) {
      const batch = toDelete.slice(start, start + DELETE_BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async pkgId => {
          const relativeId = `deliveries.${pkgId}`;
          await this.adapter.delObjectAsync(relativeId, { recursive: true });
          this.adapter.log.debug(`Removed stale delivery: ${relativeId}`);
          return pkgId;
        }),
      );
      for (const result of results) {
        if (result.status === "fulfilled") {
          deleted.add(result.value);
        } else if (deleteError === undefined) {
          deleteError = result.reason instanceof Error ? result.reason : new Error(errText(result.reason));
        }
      }
    }

    // v0.9.0 (S2): prune the caches for every REMOVED package in ONE pass over the set —
    // O(created). A createdId is `deliveries.<pkgId>` or `deliveries.<pkgId>.<state>`, so the
    // pkgId is extracted. Both caches are keyed on the same `deleted` set (v0.12.0).
    if (deleted.size > 0) {
      for (const pkgId of deleted) {
        this.deviceEnsured.delete(pkgId);
        // v0.13.0 (S1b): the collision tracker outlives a poll now, so a removed
        // package must release its id here — otherwise the bare id stays claimed
        // by a delivery that no longer exists and the surviving one keeps its suffix.
        this.idOwner.delete(pkgId);
      }
      for (const id of [...this.createdIds]) {
        if (deleted.has(StateManager.pkgIdOf(id))) {
          this.createdIds.delete(id);
        }
      }
    }
    // A package whose delete failed still exists in the object DB. It stays KNOWN so the next
    // poll retries it — dropping it here would leave an orphan device nothing ever cleans up.
    this.knownDeliveryIds = new Set(keepSet);
    for (const pkgId of toDelete) {
      if (!deleted.has(pkgId)) {
        this.knownDeliveryIds.add(pkgId);
      }
    }
    if (deleteError !== undefined) {
      // main.ts turns this into `State maintenance failed … retrying next poll`. With the caches
      // consistent, that promise now actually holds.
      throw deleteError;
    }
  }

  /**
   * Make sure the state's object is current, then write its value.
   *
   * The object part lives in {@link ensureStateObject} since v0.11.1 — this method only forwards
   * to it and then sets the value. Callers whose value is conditional must call
   * ensureStateObject themselves, unconditionally; see the note there.
   *
   * @param id State ID relative to adapter namespace
   * @param name Display name (translation object or plain string)
   * @param type Value type
   * @param role ioBroker role
   * @param val Value to set
   * @param desc Short explanation, or undefined where there is nothing to explain
   * @returns true when the broker actually wrote the value (it differed or the
   *   state was new) — the DB-backed "did anything change" signal driving
   *   `lastUpdated` (v0.10.0, M5)
   */
  /**
   * Write a state's OBJECT once per process — name, description, type and role.
   *
   * Split out of {@link createAndSet} in v0.11.1 because `lastUpdated` writes its VALUE only
   * when the tracking data actually changed. With the object write welded to the value write,
   * its object was refreshed only on that same condition — so on a quiet installation, where no
   * package moves for days, the datapoint kept the `common` it was created with forever. Measured
   * on a live install right after the v0.11.0 upgrade: all four `lastUpdated` states still
   * carried no description while their 24 siblings already had one. Same class as
   * `reference_abgeleiteter_wert_nur_bei_aenderung` — a write path behind a condition looks alive
   * because the condition is usually true, and an outdated name in the tree is what gives it away.
   *
   * The object write is unconditional now; only the VALUE keeps its condition.
   *
   * v0.11.0 changed the call itself from `setObjectNotExistsAsync` to `extendObject`: the old one
   * only ever touched an object that did not exist yet, so a changed name, description, role or
   * type reached FRESH installs only, while manifest, linter, type check and the name gate all
   * stayed green. Measured on a live install: the three permanent `summary.*` states still carried
   * their plain-English pre-i18n names, while the per-package states looked correct only because
   * packages are deleted and recreated. `extendObject` merges, so a user-set `custom`
   * (history/logging) survives — verified live on the 0.11.0 upgrade, where the recorded-datapoint
   * count went 26 -> 48 without losing a single influxdb setting. The name deliberately does NOT
   * survive: the adapter owns the names of its own states.
   *
   * @param id State ID relative to adapter namespace
   * @param name Display name (translation object or plain string)
   * @param type Value type
   * @param role ioBroker role
   * @param desc Short explanation, or undefined where there is nothing to explain
   */
  private async ensureStateObject(
    id: string,
    name: ioBroker.StringOrTranslated,
    type: ioBroker.CommonType,
    role: string,
    desc?: ioBroker.StringOrTranslated,
  ): Promise<void> {
    if (this.createdIds.has(id)) {
      return;
    }
    const common: ioBroker.StateCommon = { name, type, role, read: true, write: false };
    if (desc !== undefined) {
      common.desc = desc;
    }
    await this.adapter.extendObject(id, { type: "state", common, native: {} });
    this.createdIds.add(id);
  }

  private async createAndSet(
    id: string,
    name: ioBroker.StringOrTranslated,
    type: ioBroker.CommonType,
    role: string,
    val: ioBroker.StateValue,
    desc?: ioBroker.StringOrTranslated,
  ): Promise<boolean> {
    await this.ensureStateObject(id, name, type, role, desc);
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
