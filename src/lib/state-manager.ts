import { type AdapterInstance } from "@iobroker/adapter-core";
import { errText, LOG_SNIPPET_LEN, oneLine } from "./coerce";
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
import { carrierIcon } from "./device-icons";
import { KNOWN_STATUS_CODES, packageName, statusLabel, tName, tText } from "./i18n";
import { bareId, candidateIndex, identityOf, idCandidates, rawIdKey, sanitize } from "./package-id";
import type { ParcelDelivery } from "./types";
import { UNKNOWN_STATUS_CODE } from "./types";

/**
 * Upper bound for the `deliveries.*` object-view range query: the highest BMP
 * code unit, so the range covers every possible sanitized package id.
 */
const ID_RANGE_END = "￿";

/** A status string the parser accepts: an optional minus and digits, nothing else. */
const STRICT_INT_RE = /^-?\d+$/;

/**
 * v0.10.0 (I2): cap the parallel recursive deletes in cleanupDeliveries the
 * same way main.ts caps the update fan-out — a poll that suddenly loses many
 * packages must not flood the broker in one burst. The midnight refresh uses the same cap.
 */
const DELETE_BATCH_SIZE = 25;

/**
 * One row of a package's datapoint table — the ONE list behind the writes and the `lastUpdated`
 * decision (v0.10.0, M5). `tracksChange` says whether a new value means the TRACKING changed
 * (v0.14.0, audit B4a): the carrier's display name, the status text in the system language and the
 * estimate ("in 2 days" → "tomorrow") change without the parcel moving.
 */
type StateDef = [
  id: string,
  name: ioBroker.StringOrTranslated,
  type: ioBroker.CommonType,
  role: string,
  val: ioBroker.StateValue,
  desc: ioBroker.StringOrTranslated | undefined,
  tracksChange: boolean,
  states?: Record<string, string>,
];

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
   * v0.13.0 (audit B2): package id → signature of the device object last written
   * in this process. One write per package per process as before, plus one when
   * the name really changes — which `preserve: { common: ["name"] }` used to make
   * impossible: the device name IS the description from parcel.app, so editing
   * the description there never reached the object. The adapter owns the names of
   * its objects (a user's own name belongs in `0_userdata` or an alias), and the
   * former `preserve` also made a collision hand-over unhealable: the surviving
   * package inherited the departed one's name for good.
   */
  private readonly deviceSignature = new Map<string, string>();

  /**
   * v0.7.2: package ids known to exist as device objects. Filled from the
   * object view ONCE after adapter start by `loadExisting()` (reconciles leftovers
   * from previous runs), afterwards maintained in memory — `cleanupDeliveries` no
   * longer needs a DB round-trip per poll.
   */
  private knownDeliveryIds: Set<string> | null = null;

  /**
   * v0.4.2 (S3): which raw-tracking-key currently "owns" each sanitized id
   * within the running poll. Cleared via `resetPollState()` between polls so
   * the same delivery keeps its bare id as long as it's unique.
   */
  private readonly idOwner = new Map<string, string>();

  /**
   * v0.14.0 (audit S1/S3): raw keys of EVERY delivery the API returned in this poll, set by
   * `resetPollState(deliveries)`. A candidate id whose owner is missing here belongs to a shipment
   * that is gone — or to the same shipment under a corrected carrier code, which may take it over.
   * `null` when the caller passed no list: then nothing is taken over.
   */
  private presentKeys: Set<string> | null = null;

  /**
   * v0.14.0 (audit S2/B4b): package id → identity (tracking number, extra information, carrier
   * code) as stored in the device's `native.identity`. Filled by `loadExisting()` after a start and
   * by every successful device write; it keeps the ids stable across a restart and tells a
   * carrier-code change apart from a first sight.
   */
  private readonly storedIdentity = new Map<string, [string, string, string]>();

  /**
   * L1: per-delivery-object memo for `parseStatus`. A poll parses the SAME
   * delivery object at several sites (main's active filter, updateDelivery,
   * updateSummary's pre-pass); memoizing keyed by the object means the parse —
   * and its drift debug line — runs ONCE per delivery
   * instead of per site. No reset needed: each poll's deliveries are fresh
   * objects (JSON.parse); main.ts keeps only the LAST poll's list for the midnight
   * refresh (v0.14.0, O10) and drops it with the next poll, so the memo never grows
   * past one poll (idOwner/failedDeliveries/knownDeliveryIds store strings).
   */
  private readonly statusMemo = new WeakMap<ParcelDelivery, number>();

  /**
   * v0.12.0 (B2): raw date values already reported as drift during this poll (or since the midnight refresh). The same
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
    return sanitize(name);
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
    // v0.14.0 (audit X9): a string must be an integer and nothing else. parseInt accepted any
    // numeric PREFIX — "0abc" became 0 = delivered, and in autoRemove mode the package was deleted.
    // A number is a value and is truncated (2.7 → 2); a string with a fraction is drift.
    if (typeof raw === "string" && STRICT_INT_RE.test(raw.trim())) {
      return Number(raw.trim());
    }
    // API drift (non-numeric / non-string status_code). Return a visible
    // "unknown" sentinel instead of 0 (Delivered) — otherwise a garbage
    // status_code would silently filter the package out and remove it in
    // autoRemove mode. The active filter is `status !== 0`, so -1 stays visible.
    this.adapter.log.debug(
      `parseStatus drift: ${oneLine(JSON.stringify(raw) ?? String(raw)).slice(0, LOG_SNIPPET_LEN)} (type ${typeof raw}) → ${UNKNOWN_STATUS_CODE} (unknown, kept visible)`,
    );
    return UNKNOWN_STATUS_CODE;
  }

  /**
   * The package id of a delivery — the id segment of its device (`deliveries.<id>`).
   *
   * The candidates come from `package-id.ts` (bare id, then collision suffixes). Which delivery OWNS
   * which id lives here, in `idOwner`, and is decided in a fixed order (v0.14.0, audit S1/S3):
   *
   * 1. a delivery that already owns an id takes the first candidate that is free or its own — so
   *    a suffixed package moves up to the bare id once its partner is gone (v0.13.0, S1b);
   * 2. a delivery that owns nothing takes over an id whose owner is missing from this poll, when
   *    that owner was the SAME shipment (same non-empty tracking number and extra information,
   *    letter case aside) — a carrier code corrected in parcel.app, or a number re-typed in other
   *    letter case, keeps its objects instead of losing them to a delete plus a create;
   * 3. otherwise it takes the first free candidate.
   *
   * @param delivery The delivery to build an ID for
   * @returns the package id
   */
  packageId(delivery: ParcelDelivery): string {
    const identity = identityOf(delivery);
    const rawKey = rawIdKey(identity);
    const ownsOne = [...this.idOwner.values()].includes(rawKey);
    if (!ownsOne && this.presentKeys !== null) {
      const takeOver = this.takeOverCandidate(delivery, identity);
      if (takeOver !== undefined) {
        this.adapter.log.debug(
          `packageId: '${takeOver}' passes from '${oneLine(this.idOwner.get(takeOver) ?? "")}' to '${oneLine(rawKey)}' (same shipment)`,
        );
        this.idOwner.set(takeOver, rawKey);
        return takeOver;
      }
    }
    for (const candidate of idCandidates(delivery)) {
      const owner = this.idOwner.get(candidate);
      if (owner === rawKey) {
        return candidate;
      }
      if (owner === undefined) {
        if (candidate !== bareId(delivery)) {
          // v0.4.3 (C3): trace the collision-suffix path. Rare event, but the resulting
          // state-id divergence is hard to diagnose without a log.
          this.adapter.log.debug(`packageId collision: '${oneLine(rawKey)}' → suffixed='${candidate}'`);
        }
        this.idOwner.set(candidate, rawKey);
        return candidate;
      }
    }
    // idCandidates never ends — unreachable, but the compiler cannot know.
    throw new Error("no package id candidate left");
  }

  /**
   * Step 2 of `packageId`: the earliest candidate of this delivery owned by a shipment that is
   * missing from this poll and is the same shipment.
   *
   * @param delivery The delivery looking for an id
   * @param identity Its identity fields
   * @returns the id to take over, or undefined
   */
  private takeOverCandidate(delivery: ParcelDelivery, identity: [string, string, string]): string | undefined {
    const [tracking, extra] = identity;
    if (tracking === "") {
      // Two deliveries without a number are no evidence of being the same shipment.
      return undefined;
    }
    let best: { id: string; index: number } | undefined;
    for (const [id, owner] of this.idOwner) {
      if (this.presentKeys?.has(owner)) {
        continue;
      }
      const [ownerTracking, ownerExtra] = owner.split("\u0000");
      if (
        ownerTracking.toLowerCase() !== tracking.toLowerCase() ||
        (ownerExtra ?? "").toLowerCase() !== extra.toLowerCase()
      ) {
        continue;
      }
      const index = candidateIndex(id, delivery);
      if (index >= 0 && (best === undefined || index < best.index)) {
        best = { id, index };
      }
    }
    return best?.id;
  }

  /**
   * v0.4.2 (S3): reset the per-poll drift dedup. Call from main.ts before
   * iterating deliveries — with the FULL list the API returned (v0.14.0, audit S1/S3),
   * so `packageId` can tell a vanished shipment from a present one.
   *
   * v0.13.0 (audit S1b): the collision tracker is NOT cleared any more. It used
   * to be, so the bare id went to whichever colliding delivery came first in the
   * API's array — an order the API does not document. Two colliding packages
   * could therefore swap their state ids between two polls. The owner now keeps
   * the bare id for as long as it is present; `cleanupDeliveries` releases the
   * entry when the package is gone, and the other one moves up on the next poll.
   *
   * @param deliveries Every delivery of this poll; without it no id is taken over
   */
  resetPollState(deliveries?: ParcelDelivery[]): void {
    this.driftReported.clear();
    this.presentKeys = deliveries ? new Set(deliveries.map(d => rawIdKey(identityOf(d)))) : null;
  }

  /**
   * Write the device object when name or icon differ from what this process last
   * wrote for that package. One write per package per process in the normal case.
   *
   * @param pkgId Package id (signature key).
   * @param devicePath Relative object id of the device.
   * @param name Device name — the description from parcel.app, or the localized
   *   fallback when it sent none.
   * @param icon Inline pictogram URI, or `undefined` to leave the field untouched.
   * @param identity Tracking number, extra information and carrier code — stored in
   *   `native.identity` so the next start knows which shipment owns this id (v0.14.0, audit S2).
   */
  private async writeDeviceObject(
    pkgId: string,
    devicePath: string,
    name: ioBroker.StringOrTranslated,
    icon: string | undefined,
    identity: [string, string, string],
  ): Promise<void> {
    const signature = JSON.stringify([name, icon ?? null, identity]);
    if (this.deviceSignature.get(pkgId) === signature) {
      return;
    }
    const common: ioBroker.DeviceCommon = { name };
    if (icon !== undefined) {
      common.icon = icon;
    }
    await this.adapter.extendObject(devicePath, { type: "device", common, native: { identity } });
    this.deviceSignature.set(pkgId, signature);
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

    // v0.13.0 (B2): write the device object when its signature changed — once per
    // package per process as before, and again when parcel.app reports a new
    // description. No `preserve`: the adapter owns the name.
    // The icon is an INPUT here, not derived inside the write: only that way does
    // a stored object without an icon differ from the fresh one, so every existing
    // package gets its pictogram exactly once after the update (fleet recipe).
    const deviceName = description || packageName(trackingNumber || pkgId);
    const icon = carrierIcon(delivery.carrier_code);
    const identity = identityOf(delivery);
    // v0.14.0 (audit B4b): the identity stored before this write. No stored one (first sight, or a
    // device from before v0.14.0) counts as unchanged — otherwise the first poll after the update
    // would stamp every package.
    const previous = this.storedIdentity.get(pkgId);
    // v0.14.0 (audit X11): known BEFORE the write. If the write throws, the package still gets
    // cleaned up once it is gone, and its claim on the id is released.
    this.knownDeliveryIds?.add(pkgId);
    await this.writeDeviceObject(pkgId, devicePath, deviceName, icon, identity);
    this.storedIdentity.set(pkgId, identity);
    const carrierChanged = previous !== undefined && previous[2].toLowerCase() !== identity[2].toLowerCase();

    const statusCode = this.parseStatus(delivery);
    let statusText = statusLabel(statusCode);
    if (statusText === undefined) {
      // v0.4.3 (E3): trace unknown status-code (API drift). A future
      // parcel.app status (e.g. 9, 10) would render as "Unknown (N)"
      // without any log clue that the label table is out of date.
      this.adapter.log.debug(`status code ${statusCode} has no status_* label, using fallback`);
      // v0.14.0 (audit O8): in the system language like every other status text.
      statusText = tText("status_unknown", statusCode);
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
    const stateDefs: StateDef[] = [
      [`${devicePath}.carrier`, tName("carrier"), "string", "text", carrierName, tName("descCarrier"), false],
      [`${devicePath}.status`, tName("status"), "string", "text", statusText, tName("descStatus"), false],
      [
        `${devicePath}.statusCode`,
        tName("statusCode"),
        "number",
        "value",
        statusCode,
        tName("descStatusCode"),
        true,
        StateManager.statusStates(),
      ],
      [
        `${devicePath}.description`,
        tName("description"),
        "string",
        "text",
        description,
        tName("descDescription"),
        true,
      ],
      [`${devicePath}.trackingNumber`, tName("trackingNumber"), "string", "text", trackingNumber, undefined, true],
      [`${devicePath}.extraInfo`, tName("extraInfo"), "string", "text", extraInfo, tName("descExtraInfo"), true],
      [
        `${devicePath}.deliveryWindow`,
        tName("deliveryWindow"),
        "string",
        "text",
        deliveryWindow,
        tName("descDeliveryWindow"),
        true,
      ],
      StateManager.estimateDef(devicePath, deliveryEstimate),
      [`${devicePath}.lastEvent`, tName("lastEvent"), "string", "text", lastEvent, tName("descLastEvent"), true],
      [
        `${devicePath}.lastLocation`,
        tName("lastLocation"),
        "string",
        "text",
        lastLocation,
        tName("descLastLocation"),
        true,
      ],
    ];
    // A write counts for `lastUpdated` only where the row tracks the parcel (audit B4a).
    const changed = await Promise.all(
      stateDefs.map(
        async ([id, name, type, role, val, desc, tracksChange, states]) =>
          (await this.createAndSet(id, name, type, role, val, desc, states)) && tracksChange,
      ),
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
    // v0.14.0 (audit B4b): a new carrier CODE is a change of the tracking — the state values may all
    // look the same (the carrier's display name does not count, see StateDef).
    if (carrierChanged || changed.some(Boolean)) {
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
   * v0.14.0 (audit O7): the plain-text list the admin shows next to `statusCode` — every documented
   * code plus the unknown sentinel. PLAIN strings in the system language: the admin's value
   * renderer takes `common.states` values as React children, and a translation object there is
   * React error #31 (the whole object view goes blank).
   *
   * @returns code → label
   */
  private static statusStates(): Record<string, string> {
    const states: Record<string, string> = {
      [String(UNKNOWN_STATUS_CODE)]: tText("status_unknown", UNKNOWN_STATUS_CODE),
    };
    for (const code of KNOWN_STATUS_CODES) {
      states[String(code)] = statusLabel(code) ?? String(code);
    }
    return states;
  }

  /**
   * The estimate row of a package — shared by the poll and the midnight refresh, so both write the
   * same object.
   *
   * @param devicePath Relative object id of the package device
   * @param estimate The estimate wording
   * @returns the datapoint row
   */
  private static estimateDef(devicePath: string, estimate: string): StateDef {
    return [
      `${devicePath}.deliveryEstimate`,
      tName("deliveryEstimate"),
      "string",
      "text",
      estimate,
      tName("descDeliveryEstimate"),
      false,
    ];
  }

  /**
   * v0.14.0 (audit O10): recompute what depends on the DATE alone — each package's estimate and the
   * summary — without asking parcel.app. main.ts calls it right after local midnight with the
   * deliveries of the last poll, so "tomorrow" turns into "today" at the start of the day and not
   * with the first poll after it. No `lastUpdated`: nothing about the parcel changed.
   *
   * @param visible Deliveries that carry states, from the last poll (minus failed writes)
   * @param pkgIds Their package ids, index-aligned to `visible`
   * @param active Every active delivery of the last poll — the summary counts them all, like the poll
   */
  async refreshDerived(visible: ParcelDelivery[], pkgIds: string[], active: ParcelDelivery[]): Promise<void> {
    // A new day: a drift line reported yesterday may be reported once more.
    this.driftReported.clear();
    for (let start = 0; start < visible.length; start += DELETE_BATCH_SIZE) {
      await Promise.all(
        visible.slice(start, start + DELETE_BATCH_SIZE).map((delivery, offset) => {
          const estimate = calculateDeliveryEstimate(delivery, this.parseStatus(delivery), this.viewLog);
          const [id, name, type, role, val, desc] = StateManager.estimateDef(
            `deliveries.${pkgIds[start + offset]}`,
            estimate,
          );
          return this.createAndSet(id, name, type, role, val, desc);
        }),
      );
    }
    await this.updateSummary(active);
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
   * Read the package devices that already exist — ONCE after adapter start (v0.7.2), and since
   * v0.14.0 (audit S2) BEFORE the ids of the first poll are handed out: every device written since
   * v0.14.0 carries its identity in `native.identity`, which seeds the id owners. Without it, a
   * restart handed the bare id to whichever colliding delivery came first in the API's array, and
   * two packages swapped their whole state subtrees. main.ts calls this in every poll until it
   * succeeded; afterwards it returns at once.
   */
  async loadExisting(): Promise<void> {
    if (this.knownDeliveryIds !== null) {
      return;
    }
    const objects = await this.adapter.getObjectViewAsync("system", "device", {
      startkey: `${this.adapter.namespace}.deliveries.`,
      endkey: `${this.adapter.namespace}.deliveries.${ID_RANGE_END}`,
    });
    if (!objects?.rows) {
      // v0.4.3 (E2): trace the no-op path — happens when getObjectViewAsync returns falsy.
      // The known-set stays unseeded, so cleanup deletes nothing and the next poll asks again.
      this.adapter.log.debug("loadExisting: no objects view available, skipping");
      return;
    }
    const known = new Set<string>();
    for (const row of objects.rows) {
      // The range query guarantees the namespace prefix — cut it instead of
      // pattern-replacing (v0.10.0, KISS-13).
      const pkgId = StateManager.pkgIdOf(row.id.slice(this.adapter.namespace.length + 1));
      if (!pkgId) {
        continue;
      }
      known.add(pkgId);
      const identity = StateManager.identityFrom(row.value?.native?.identity);
      if (identity !== null) {
        // A claim made in this process wins over the stored one.
        if (!this.idOwner.has(pkgId)) {
          this.idOwner.set(pkgId, rawIdKey(identity));
        }
        if (!this.storedIdentity.has(pkgId)) {
          this.storedIdentity.set(pkgId, identity);
        }
      }
    }
    this.knownDeliveryIds = known;
  }

  /**
   * A stored `native.identity`, accepted only as exactly three strings — the object DB is outside
   * this process and anyone can have edited it.
   *
   * @param value The stored value
   * @returns the identity, or null
   */
  private static identityFrom(value: unknown): [string, string, string] | null {
    return Array.isArray(value) && value.length === 3 && value.every(part => typeof part === "string")
      ? [value[0], value[1], value[2]]
      : null;
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
    await this.loadExisting();
    if (this.knownDeliveryIds === null) {
      return;
    }

    const keepSet = new Set(keepIds);
    // v0.4.2 (S1): collect first, then delete in parallel — capped in batches
    // (v0.10.0, I2) like the update fan-out in main.ts.
    const toDelete = [...this.knownDeliveryIds].filter(pkgId => !keepSet.has(pkgId));

    // v0.12.0: a delete that FAILED must change nothing, and a delete that landed must clear
    // EVERY cache in the same step. Before this, `deviceSignature` (then `deviceEnsured`) was pruned inside the loop while
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
        this.deviceSignature.delete(pkgId);
        this.storedIdentity.delete(pkgId);
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
   * @param states Plain-text value list for the admin, where the value is a code
   */
  private async ensureStateObject(
    id: string,
    name: ioBroker.StringOrTranslated,
    type: ioBroker.CommonType,
    role: string,
    desc?: ioBroker.StringOrTranslated,
    states?: Record<string, string>,
  ): Promise<void> {
    if (this.createdIds.has(id)) {
      return;
    }
    const common: ioBroker.StateCommon = { name, type, role, read: true, write: false };
    if (desc !== undefined) {
      common.desc = desc;
    }
    if (states !== undefined) {
      common.states = states;
    }
    await this.adapter.extendObject(id, { type: "state", common, native: {} });
    this.createdIds.add(id);
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
   * @param states Plain-text value list for the admin, where the value is a code
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
    desc?: ioBroker.StringOrTranslated,
    states?: Record<string, string>,
  ): Promise<boolean> {
    await this.ensureStateObject(id, name, type, role, desc, states);
    // The installed @iobroker/types 7.2.2 still types this promise as `string` (shared.d.ts:
    // `SetStateChangedPromise` = the first callback argument, the id), but
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
