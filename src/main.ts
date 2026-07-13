import * as utils from "@iobroker/adapter-core";
import { I18n } from "@iobroker/adapter-core";
import { join } from "node:path";
import { coerceClampedInt, errText, isTrueish, oneLine } from "./lib/coerce";
import { ParcelClient, RETRY_AFTER_DEFAULT_SEC, RETRY_AFTER_MAX_SEC } from "./lib/parcel-client";
import { StateManager } from "./lib/state-manager";
import { DELIVERED_STATUS_CODE } from "./lib/types";
import type { AddDeliveryRequest } from "./lib/types";

const MIN_POLL_INTERVAL = 5;
const MAX_POLL_INTERVAL = 60;
const DEFAULT_POLL_INTERVAL = 10;
// Minimum 60s between polls. Also the natural pacing after addDelivery: a
// typical single add still polls immediately (the last poll is >60s ago),
// while a burst of adds collapses to at most one extra GET per minute.
const MIN_POLL_GAP_MS = 60_000;
/** v0.4.2 (M6): minimum length for an apiKey value to even be considered valid. */
const MIN_API_KEY_LENGTH = 10;
// v0.9.0 (S5): cap addDelivery field lengths. A sendTo caller is local, but a
// runaway script must not push a multi-MB POST body to parcel.app. Identifiers
// are short; this is generous for a description.
const MAX_ADD_FIELD_LEN = 512;
// v0.9.0 (S3): cap the per-poll broker fan-out. Updates run in batches of this
// size instead of all deliveries at once, so an abnormally large API response
// can't flood the broker with thousands of concurrent writes.
const UPDATE_BATCH_SIZE = 25;
// v0.9.0 (S4): client-side throttle on addDelivery POSTs. parcel.app enforces
// ~20 POST/day server-side; this caps a runaway/buggy script's burst so it can't
// hammer the API. The window is generous enough never to block a real batch-add
// (the daily server limit is the real cap).
const MAX_ADDS_PER_WINDOW = 20;
const ADD_WINDOW_MS = 60_000;

/**
 * Node transport-level error codes treated as (transient) NETWORK problems:
 * DNS, connection refused/reset, unreachable — plus EPIPE/ECONNABORTED/EPROTO
 * (v0.10.0, I9), which belong to the same warn+keep-retrying class.
 */
const NETWORK_ERROR_CODES = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "EPIPE",
  "ECONNABORTED",
  "EPROTO",
]);

/**
 * v0.10.0 (L12): the seam contracts name exactly the members main uses —
 * structural Picks let the orchestration tests inject plain object fakes
 * without unsafe double-casts, and the compiler documents what a fake must
 * provide.
 */
type ClientLike = Pick<
  ParcelClient,
  "getDeliveries" | "getCarrierName" | "addDelivery" | "testConnection" | "cancelAll"
>;
type StateManagerLike = Pick<
  StateManager,
  "resetPollState" | "packageId" | "parseStatus" | "updateDelivery" | "updateSummary" | "cleanupDeliveries"
>;

/**
 * ioBroker adapter for parcel.app package tracking. Exported so the
 * orchestration unit tests can drive its lifecycle/poll handlers directly.
 */
export class ParcelappAdapter extends utils.Adapter {
  private client: ClientLike | null = null;
  private stateManager: StateManagerLike | null = null;
  /**
   * Factories for the HTTP client + state manager — default to the real
   * constructors. Test seams (fleet pattern): unit tests replace these with
   * fakes to exercise the poll orchestration (throttle/rate-limit interplay,
   * error routing, failure dedup) without real network.
   *
   * @param apiKey parcel.app API key
   */
  private makeClient: (apiKey: string) => ClientLike = apiKey =>
    new ParcelClient(apiKey, { debug: (m: string) => this.log.debug(m) });
  private makeStateManager: () => StateManagerLike = () => new StateManager(this);
  private pollTimer: ioBroker.Interval | undefined = undefined;
  private isPolling = false;
  private lastPollTime = 0;
  private rateLimitedUntil = 0;
  private lastErrorCode = "";
  /**
   * v0.10.0 (L2): set in onUnload. onReady checks it after its awaits so a
   * stop during the first poll can no longer arm the interval or log
   * "started" after the unload already ran; batch failures during shutdown
   * degrade to debug.
   */
  private unloaded = false;
  /**
   * Package ids (not raw tracking numbers) whose last updateDelivery failed.
   * Keyed like the states so the dedup survives a sanitize collision or a
   * missing tracking number; pruned each poll against the visible pkgIds.
   */
  private failedDeliveries = new Set<string>();
  /** Timestamps of recent addDelivery POSTs — the S4 throttle window. */
  private addTimestamps: number[] = [];
  /**
   * L2: true while a checkConnection test GET is in flight. A test hits the same
   * 20/hour GET budget as polling; this guards against a concurrent second test
   * (double-click / admin re-render) stacking a redundant GET. A sequential
   * re-test after the current one settles runs normally.
   */
  private testConnectionInFlight = false;
  /**
   * v0.4.4: short-lived test-clients spawned from `checkConnection` admin
   * messages. The prod-`this.client` is what `onUnload` cancels, so these
   * need their own registry to be reachable at shutdown. Without this, an
   * admin clicking "Test Connection" right before adapter-stop could keep
   * the process alive past js-controller's 4-second kill deadline.
   */
  private testClients = new Set<ClientLike>();

  /** @param options Adapter options */
  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({
      ...options,
      name: "parcelapp",
    });
    this.on("ready", this.onReady.bind(this));
    this.on("unload", this.onUnload.bind(this));
    this.on("message", this.onMessage.bind(this));
  }

  private async onReady(): Promise<void> {
    try {
      // I18n.init resolves system.config.language itself (adapter-core reads
      // the foreign object internally; unknown languages fall back to English)
      // — the former separate getForeignObject round-trip and the local
      // resolveLanguage step are gone with the STATUS_LABELS table (L20).
      await I18n.init(join(this.adapterDir, "admin"), this);
      this.log.debug(`onReady: starting (autoRemoveDelivered=${this.config.autoRemoveDelivered})`);

      await this.setState("info.connection", { val: false, ack: true });

      const { apiKey } = this.config;
      if (!apiKey || apiKey.trim().length < MIN_API_KEY_LENGTH) {
        this.log.error("No valid API key configured — please enter your parcel.app API key in the adapter settings");
        return;
      }

      this.client = this.makeClient(apiKey.trim());
      this.stateManager = this.makeStateManager();

      try {
        await this.cleanupObsoleteStates();
      } catch (err) {
        // C8: a cleanup failure must not abort startup. Without this guard the
        // outer catch would skip arming the poll interval below, and the adapter
        // would never poll until a manual restart. Degrade to a warning.
        this.log.warn(`cleanupObsoleteStates failed (continuing): ${errText(err)}`);
      }

      await this.poll();

      // v0.10.0 (L2): a stop during the awaits above must not arm a timer or
      // log a start line after onUnload already ran.
      if (this.unloaded) {
        return;
      }

      const interval = ParcelappAdapter.coercePollInterval(this.config.pollInterval);
      this.log.debug(`pollInterval: raw=${JSON.stringify(this.config.pollInterval)} resolved=${interval}min`);
      const intervalMs = interval * 60 * 1000;
      this.pollTimer = this.setInterval(() => {
        void this.poll().catch(err => this.log.error(`Scheduled poll failed: ${errText(err)}`));
      }, intervalMs);

      this.log.info(`Parcel tracking started — polling every ${interval} minutes`);
    } catch (err: unknown) {
      this.log.error(`onReady failed: ${errText(err)}`);
      // v0.10.0 (L4): a transient startup failure (i18n files, DB hiccup) used
      // to leave a green-looking zombie — no client, no timer, no retry until
      // a manual restart. Terminate instead: js-controller restarts the
      // instance, which self-heals the transient case; its restart-loop guard
      // backstops a persistent one.
      if (!this.unloaded) {
        this.terminate("startup failed — requesting restart", utils.EXIT_CODES.START_IMMEDIATELY_AFTER_STOP);
      }
    }
  }

  /**
   * v0.4.2 (M5+X5): delegate to the shared `coerceClampedInt` helper.
   *
   * @param raw Raw `pollInterval` from admin config (number or numeric string).
   */
  private static coercePollInterval(raw: unknown): number {
    return coerceClampedInt(raw, MIN_POLL_INTERVAL, MAX_POLL_INTERVAL, DEFAULT_POLL_INTERVAL);
  }

  private onUnload(callback: () => void): void {
    this.unloaded = true;
    try {
      if (this.pollTimer) {
        this.clearInterval(this.pollTimer);
        this.pollTimer = undefined;
      }
      // v0.4.2 (M11+P1): cancel every in-flight HTTPS request so a slow
      // parcel.app endpoint doesn't keep the adapter alive past
      // js-controller's 4-second kill deadline. cancelAll also marks the
      // client terminal (v0.10.0, L3) — requests started after this point
      // are refused instead of opening fresh connections.
      this.client?.cancelAll();
      // v0.4.4: also abort any short-lived test-client (from checkConnection)
      // whose HTTPS-request might still be inflight at shutdown — the prod
      // `this.client.cancelAll()` only touches the production-client.
      for (const tc of this.testClients) {
        tc.cancelAll();
      }
      this.testClients.clear();
      // v0.4.2 (M10): explicit `.catch(() => {})` on the fire-and-forget so
      // a broker-already-down doesn't leak as an unhandled rejection.
      void this.setState("info.connection", { val: false, ack: true }).catch(() => {
        /* broker is shutting down — ignore */
      });
    } catch (err) {
      // v0.4.3 (G4): replace silent `// ignore` with a trace so shutdown
      // errors leave a debug breadcrumb. Broker-already-down errors here
      // are expected — debug-level keeps them out of the user log.
      try {
        this.log.debug(`onUnload error (ignored): ${errText(err)}`);
      } catch {
        /* logger already gone — nothing left to report to */
      }
    } finally {
      // v0.10.0 (I7): the callback is the contract with js-controller —
      // structurally guaranteed exactly once, even if the catch-path throws.
      callback();
    }
  }

  private async onMessage(obj: ioBroker.Message): Promise<void> {
    try {
      // v0.4.3 (F1): entry log BEFORE the early-return — broadcast messages
      // without callback wouldn't be visible otherwise. Inside the try since
      // v0.10.0 (I6) so the handler body is gap-free top-level guarded.
      this.log.debug(
        `onMessage: command='${oneLine(String(obj?.command ?? ""))}' from='${obj?.from}' has-callback=${!!obj?.callback}`,
      );
      if (!obj?.command || !obj.callback) {
        return;
      }

      switch (obj.command) {
        case "checkConnection":
          await this.handleCheckConnection(obj);
          break;
        case "addDelivery":
          await this.handleAddDelivery(obj);
          break;
        default:
          // v0.4.3 (F6): trace unknown command before sendTo.
          this.log.debug(`onMessage: unknown command '${oneLine(String(obj.command))}'`);
          this.sendTo(obj.from, obj.command, { error: "Unknown command" }, obj.callback);
      }
    } catch (err) {
      // v0.4.3 (F7): trace catch so the debug log shows what failed. The
      // reply itself is guarded too (v0.10.0, I6) — a synchronous sendTo
      // throw must not escape the message handler. checkConnection replies
      // use the admin {error} envelope (H1), scripts keep the documented
      // {success, error_message} shape.
      try {
        this.log.debug(`onMessage: '${oneLine(String(obj?.command ?? ""))}' failed: ${errText(err)}`);
        if (obj?.callback) {
          const reply =
            obj.command === "checkConnection"
              ? { error: errText(err) }
              : { success: false, error_message: errText(err) };
          this.sendTo(obj.from, obj.command, reply, obj.callback);
        }
      } catch {
        /* reply channel gone — nothing left to do */
      }
    }
  }

  /**
   * Admin "Test Connection" button (H1). The jsonConfig sendTo component reads
   * ONLY `response.error` / `response.result` — never success/message — so the
   * internal `{success, message}` result is mapped to that contract here.
   * Before this, a FAILED test showed a false-positive "Ok" in the admin
   * (fleet fix; beszel's message-router is the model).
   *
   * @param obj The sendTo message (validated: command + callback present)
   */
  private async handleCheckConnection(obj: ioBroker.Message): Promise<void> {
    const msg = obj.message as { apiKey?: string };
    const key = msg?.apiKey?.trim() || "";
    if (!key || key.length < MIN_API_KEY_LENGTH) {
      // v0.4.3 (F2): trace the reject before sendTo.
      this.log.debug("checkConnection: apiKey too short");
      this.sendTo(obj.from, obj.command, { error: "API key is too short" }, obj.callback);
      return;
    }
    // L2: a Test-Connection GET counts against the same 20/hour budget as
    // polling. Guard against a concurrent second test (double-click / admin
    // re-render) so stacked clicks can't each burn a GET (which could later trip
    // the poll's rate-limit cooldown). Set BEFORE the await so the check is
    // synchronous against a still-in-flight first test.
    if (this.testConnectionInFlight) {
      this.log.debug("checkConnection: a test is already running");
      this.sendTo(obj.from, obj.command, { error: "A connection test is already running — please wait" }, obj.callback);
      return;
    }
    this.testConnectionInFlight = true;
    // v0.4.3: same debug-logger as the prod client so checkConnection
    // failures get the same HTTPS-layer trace (via the makeClient seam).
    const testClient = this.makeClient(key);
    // v0.4.4: register test-client so onUnload can abort its inflight
    // HTTPS-request — the adapter's `this.client.cancelAll()` only
    // touches the prod-client, not these short-lived test-clients.
    this.testClients.add(testClient);
    try {
      const result = await testClient.testConnection();
      // v0.4.3 (F3): trace checkConnection result.
      this.log.debug(`checkConnection: result=${result.success ? "ok" : "fail"} (${result.message})`);
      this.sendTo(
        obj.from,
        obj.command,
        result.success ? { result: result.message } : { error: result.message },
        obj.callback,
      );
    } finally {
      this.testClients.delete(testClient);
      this.testConnectionInFlight = false;
    }
  }

  /**
   * Reply an addDelivery failure to the sendTo caller. This is the documented
   * script API envelope (`{success: false, error_message}`) — unchanged for
   * backward compatibility; only the admin checkConnection uses {error}.
   *
   * @param obj The sendTo message being answered
   * @param message Human-readable failure reason
   */
  private replyAddError(obj: ioBroker.Message, message: string): void {
    this.sendTo(obj.from, obj.command, { success: false, error_message: message }, obj.callback);
  }

  /**
   * Script-facing addDelivery command: validate the message shape, cap field
   * lengths, throttle bursts, forward to the API and trigger a poll on
   * success. Extracted from the onMessage switch (M9) — one command, one
   * method, one change reason.
   *
   * @param obj The sendTo message (validated: command + callback present)
   */
  private async handleAddDelivery(obj: ioBroker.Message): Promise<void> {
    if (!this.client) {
      // v0.4.3 (F4): trace addDelivery-before-init.
      this.log.debug("addDelivery: adapter not initialized");
      this.replyAddError(obj, "Adapter not initialized");
      return;
    }
    // v0.7.2: obj.message is `unknown`-shaped — a script calling
    // sendTo("parcelapp", "addDelivery", null) used to surface as an
    // ugly TypeError through the catch instead of a clear validation
    // message. Coerce to a plain object and validate required fields.
    const raw = obj.message;
    const msg = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    if (
      typeof msg.tracking_number !== "string" ||
      msg.tracking_number.length === 0 ||
      typeof msg.carrier_code !== "string" ||
      msg.carrier_code.length === 0 ||
      typeof msg.description !== "string" ||
      msg.description.length === 0
    ) {
      this.log.debug("addDelivery: missing tracking_number/carrier_code/description in message");
      this.replyAddError(obj, "tracking_number, carrier_code and description are required");
      return;
    }
    // v0.9.0 (S5): cap field lengths so a runaway local script can't push
    // a multi-MB POST body to parcel.app. Checked after the required-field
    // guard above so the two validation messages stay distinct.
    if (
      msg.tracking_number.length > MAX_ADD_FIELD_LEN ||
      msg.carrier_code.length > MAX_ADD_FIELD_LEN ||
      msg.description.length > MAX_ADD_FIELD_LEN ||
      (typeof msg.language === "string" && msg.language.length > MAX_ADD_FIELD_LEN)
    ) {
      this.log.debug("addDelivery: a field exceeds the maximum length");
      this.replyAddError(obj, `each field must be at most ${MAX_ADD_FIELD_LEN} characters`);
      return;
    }
    // Pass the optional API fields through when the caller supplies them
    // (language: ISO 639-1 two-letter code; send_push_confirmation: push
    // notification once the delivery is added).
    const request: AddDeliveryRequest = {
      tracking_number: msg.tracking_number,
      carrier_code: msg.carrier_code,
      description: msg.description,
    };
    if (typeof msg.language === "string" && msg.language.length > 0) {
      request.language = msg.language;
    }
    if (typeof msg.send_push_confirmation === "boolean") {
      request.send_push_confirmation = msg.send_push_confirmation;
    }
    // v0.9.0 (S4): throttle addDelivery POSTs. parcel.app caps ~20/day
    // server-side; this stops a runaway/buggy script from hammering the API
    // with a burst. Record the attempt before the await so concurrent
    // callers count too.
    const nowMs = Date.now();
    this.addTimestamps = this.addTimestamps.filter(t => nowMs - t < ADD_WINDOW_MS);
    if (this.addTimestamps.length >= MAX_ADDS_PER_WINDOW) {
      this.log.warn(`addDelivery throttled: more than ${MAX_ADDS_PER_WINDOW} requests within ${ADD_WINDOW_MS / 1000}s`);
      this.replyAddError(obj, `too many addDelivery requests; max ${MAX_ADDS_PER_WINDOW} per ${ADD_WINDOW_MS / 1000}s`);
      return;
    }
    this.addTimestamps.push(nowMs);
    const addResult = await this.client.addDelivery(request);
    // v0.4.3 (F5): trace addDelivery result with the (flattened) tracking number.
    // v0.10.0 (L9): the drift-guarded isTrueish — getDeliveries hardens the same
    // API flag; a drifted `success: "false"` string must not read as truthy.
    const added = isTrueish(addResult.success);
    this.log.debug(`addDelivery: '${oneLine(request.tracking_number)}' result=${added ? "ok" : "fail"}`);
    this.sendTo(obj.from, obj.command, addResult, obj.callback);
    if (added) {
      // v0.10.0 (L5): plain poll, no force — a single add still polls right
      // away (the last poll is usually >60s back), but an add-burst can no
      // longer stack force-GETs past the 20/h API budget. Nothing is lost:
      // the server caches the list ~45-90 min, a fresh package rarely shows
      // tracking data immediately anyway.
      void this.poll().catch(err => this.log.error(`Poll after addDelivery failed: ${errText(err)}`));
    }
  }

  private async cleanupObsoleteStates(): Promise<void> {
    // One getObject per adapter start, forever — deliberately kept (I3/ARCH-24):
    // a one-shot migration marker would cost more mechanics than this read.
    // Drop the list entirely at the next major once 0.1.x installs are gone.
    const obsoleteStates = [
      "summary.json", // removed in 0.2.0
    ];
    for (const stateId of obsoleteStates) {
      const obj = await this.getObjectAsync(stateId);
      if (obj) {
        await this.delObjectAsync(stateId);
        this.log.debug(`Removed obsolete state: ${stateId}`);
      }
    }
  }

  /**
   * Classify an error for deduplication and log-level decisions.
   *
   * v0.10.0 (M1): the client codes every failure it raises (TIMEOUT,
   * PARSE_ERROR, ABORTED, RATE_LIMITED, …) — a present machine code always
   * wins. The message-substring sniff only remains for code-less foreign
   * errors, so an API error_message merely CONTAINING "timeout" can no longer
   * be misclassified.
   *
   * @param error The error to classify
   */
  private classifyError(error: Error & { code?: string }): string {
    if (error.code) {
      if (NETWORK_ERROR_CODES.has(error.code)) {
        return "NETWORK";
      }
      if (error.code === "ETIMEDOUT") {
        return "TIMEOUT";
      }
      return error.code;
    }
    if (error.message.includes("timeout")) {
      return "TIMEOUT";
    }
    return "UNKNOWN";
  }

  private async poll(): Promise<void> {
    if (this.isPolling || !this.client || !this.stateManager) {
      // v0.10.0 (M4): make the re-entry/uninitialized skip visible like the
      // rate-limit/throttle skips below — this used to be the one silent spot
      // where "the adapter does nothing" left no trace.
      this.log.debug("Skipping poll — already running or not initialized");
      return;
    }
    // v0.10.0 (L14): local bindings instead of non-null assertions in the
    // closures below — provable narrowing the compiler checks, robust against
    // a future refactor nulling the fields mid-poll.
    const client = this.client;
    const stateManager = this.stateManager;

    const now = Date.now();
    // v0.4.3 (B1): poll-entry anchor — visible after the re-entry guard but
    // before the rate-limit/throttle skips. Shows mode + current error state
    // so the debug log gives context for whatever follows.
    const autoRemoveMode = this.config.autoRemoveDelivered !== false;
    this.log.debug(`poll: starting (autoRemove=${autoRemoveMode}, lastErrorCode='${this.lastErrorCode}')`);

    // Skip if rate limited
    if (now < this.rateLimitedUntil) {
      const waitMin = Math.ceil((this.rateLimitedUntil - now) / 60_000);
      this.log.debug(`Skipping poll — rate limited for ${waitMin} more minute(s)`);
      return;
    }

    // Throttle: minimum gap between polls (also paces the poll after a
    // successful addDelivery — see handleAddDelivery).
    if (now - this.lastPollTime < MIN_POLL_GAP_MS) {
      this.log.debug("Skipping poll — too soon after last poll");
      return;
    }

    this.isPolling = true;
    this.lastPollTime = now;
    try {
      // When keeping delivered packages, use "recent" to get them from API
      const deliveries = await client.getDeliveries(autoRemoveMode ? "active" : "recent");

      // Reset error state on success
      this.rateLimitedUntil = 0;
      if (this.lastErrorCode) {
        this.log.info("Connection restored");
        this.lastErrorCode = "";
      }
      await this.setStateChangedAsync("info.connection", { val: true, ack: true });

      // Split into active (non-delivered) and visible (what gets states)
      const activeDeliveries = deliveries.filter(d => stateManager.parseStatus(d) !== DELIVERED_STATUS_CODE);
      const visibleDeliveries = autoRemoveMode ? activeDeliveries : deliveries;

      // v0.4.2 (S3): reset the per-poll collision tracker, then compute every
      // package id in a deterministic sequential pre-pass (stable array order)
      // BEFORE the parallel updates — collision-suffixing is then deterministic
      // and packageId runs exactly once per delivery instead of twice.
      stateManager.resetPollState();
      const pkgIds = visibleDeliveries.map(d => stateManager.packageId(d));

      // v0.4.2 (M4): per-delivery updates run in parallel, each wrapped in
      // try/catch so one bad delivery doesn't poison the others.
      // v0.9.0 (S3): process the updates in bounded batches instead of one
      // broker fan-out for ALL deliveries at once. The keep-set is still every
      // visible pkgId (computed above), so this only caps concurrency — it never
      // drops a package. A normal poll (a handful of packages) is a single batch.
      if (visibleDeliveries.length > UPDATE_BATCH_SIZE) {
        this.log.debug(`Updating ${visibleDeliveries.length} deliveries in batches of ${UPDATE_BATCH_SIZE}`);
      }
      for (let start = 0; start < visibleDeliveries.length; start += UPDATE_BATCH_SIZE) {
        const batch = visibleDeliveries.slice(start, start + UPDATE_BATCH_SIZE);
        await Promise.all(
          batch.map(async (delivery, offset) => {
            const pkgId = pkgIds[start + offset];
            // Pre-sanitize the externally-sourced strings once for logging. The
            // fields are optional (the API can drop them), so default to "" before
            // oneLine flattens them onto a single log line.
            const tracking = oneLine(delivery.tracking_number ?? "");
            const carrier = oneLine(delivery.carrier_code ?? "");
            try {
              // v0.4.3 (C1): per-delivery entry. ~10 packages × 144 polls/day
              // = ~1440 debug lines/day — acceptable at debug-level. Line stays
              // short (tracking + carrier + status only, no full delivery JSON).
              // v0.10.0 (M6): status_code is typed number|string (drift), so it
              // is flattened like the other externally-sourced fields.
              this.log.debug(
                `updateDelivery: '${tracking}' carrier=${carrier} status=${oneLine(String(delivery.status_code))}`,
              );
              const carrierName = await client.getCarrierName(delivery.carrier_code);
              await stateManager.updateDelivery(delivery, carrierName, pkgId);
              this.failedDeliveries.delete(pkgId);
            } catch (err) {
              const msg = errText(err);
              if (this.failedDeliveries.has(pkgId)) {
                this.log.debug(`Failed to update '${tracking}': ${msg}`);
              } else if (this.unloaded) {
                // v0.10.0 (L2): broker teardown mid-batch is expected noise
                // during shutdown, not a per-package warning.
                this.log.debug(`Failed to update '${tracking}' during shutdown: ${msg}`);
              } else {
                this.log.warn(`Failed to update '${tracking}': ${msg}`);
                this.failedDeliveries.add(pkgId);
              }
            }
          }),
        );
      }

      // v0.9.0 (C1): keep-set = EVERY package the API still returns this poll
      // (pkgIds), NOT only the writes that just succeeded. A transient
      // updateDelivery failure leaves a package's states stale, but it must not
      // drop the package from cleanup — that would delete a still-present
      // package's states (and any user-set device name) at green info.connection.
      // v0.10.0 (M2): broker-side failures in cleanup/summary are NOT API
      // failures — they must neither flip info.connection to false (the GET
      // above just succeeded) nor run through the API error classification.
      try {
        await stateManager.cleanupDeliveries(pkgIds);
        // Update summary (always uses active/non-delivered)
        await stateManager.updateSummary(activeDeliveries);
      } catch (err) {
        this.log.warn(`State maintenance failed (API connection is fine, retrying next poll): ${errText(err)}`);
      }

      // Keep failedDeliveries bounded: drop entries for package ids no longer
      // present, so packages that vanish from the API don't linger forever.
      const seenPkgIds = new Set(pkgIds);
      for (const id of [...this.failedDeliveries]) {
        if (!seenPkgIds.has(id)) {
          this.failedDeliveries.delete(id);
        }
      }

      this.log.debug(`Polled ${visibleDeliveries.length} deliveries (${activeDeliveries.length} active)`);
    } catch (err) {
      await this.handlePollError(err as Error & { code?: string; retryAfterSeconds?: number });
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Classify + route a poll failure: log level, dedup, cooldown and the
   * info.connection=false write. Extracted from poll()'s catch (M9) so the
   * happy path reads as a plain sequence and the error policy sits next to
   * classifyError. Dispatches on the CLASSIFIED code only (L6) — one source
   * of truth for the error class.
   *
   * @param error The poll failure (usually an ApiError from the client)
   */
  private async handlePollError(error: Error & { code?: string; retryAfterSeconds?: number }): Promise<void> {
    const errorCode = this.classifyError(error);
    const isRepeat = errorCode === this.lastErrorCode;
    this.lastErrorCode = errorCode;

    switch (errorCode) {
      case "ABORTED":
        // v0.10.0 (M1): expected during shutdown — cancelAll aborts the
        // in-flight GET. A deliberate stop must not paint a red error line.
        this.log.debug(`Poll aborted: ${error.message}`);
        break;
      case "RATE_LIMITED": {
        // v0.4.2 (M9): clamp Retry-After into [60s, 24h] (shared constants
        // with the client parser, L7). A bogus 0/negative/fractional value
        // must neither wipe the cooldown nor set it for milliseconds.
        const rawCooldown = error.retryAfterSeconds ?? 0;
        const cooldownSec =
          Number.isFinite(rawCooldown) && rawCooldown > 0
            ? Math.min(RETRY_AFTER_MAX_SEC, Math.max(60, Math.floor(rawCooldown)))
            : RETRY_AFTER_DEFAULT_SEC;
        this.rateLimitedUntil = Date.now() + cooldownSec * 1000;
        // v0.10.0 (M3): warn once — a persistent 429 repeats at debug.
        const line = `Rate limit hit — pausing API requests for ${Math.ceil(cooldownSec / 60)} minute(s)`;
        if (isRepeat) {
          this.log.debug(line);
        } else {
          this.log.warn(line);
        }
        break;
      }
      case "FORBIDDEN": {
        // v0.4.2 (P3): 403 is a permission issue (e.g. Premium subscription
        // expired). Reauth wouldn't help — surface a clear hint.
        // v0.10.0 (M3): once at error level, repeats at debug — not 144
        // identical error lines per day for one unchanged account problem.
        const line =
          "parcel.app returned 403 Forbidden — your account may not have an active Premium subscription, or the API key was revoked. Check your account on parcelapp.net.";
        if (isRepeat) {
          this.log.debug(line);
        } else {
          this.log.error(line);
        }
        break;
      }
      case "INVALID_API_KEY": {
        // v0.10.0 (M3): first occurrence at error (the user must fix the
        // config; info.connection goes red too) — repeats at debug.
        const line = "Invalid API key — please check your parcel.app API key";
        if (isRepeat) {
          this.log.debug(line);
        } else {
          this.log.error(line);
        }
        break;
      }
      case "NETWORK":
        if (isRepeat) {
          this.log.debug(`Poll failed (ongoing): ${error.message}`);
        } else {
          this.log.warn("Cannot reach parcel.app API — will keep retrying");
        }
        break;
      case "TIMEOUT":
        if (isRepeat) {
          this.log.debug(`Poll failed (ongoing): ${error.message}`);
        } else {
          this.log.warn("API request timeout — will retry next cycle");
        }
        break;
      default:
        if (isRepeat) {
          // Same error as last time — don't spam the log
          this.log.debug(`Poll failed (ongoing): ${error.message}`);
        } else {
          this.log.error(`Poll failed: ${error.message}`);
        }
    }

    // C2: setStateChangedAsync avoids redundant `false` writes on sustained
    // failure. The `.catch` keeps poll() from rejecting when the broker is
    // already down, so the fire-and-forget callers never see an unhandled
    // rejection (no global process handler needed).
    await this.setStateChangedAsync("info.connection", { val: false, ack: true }).catch(() => {
      /* broker shutting down — ignore */
    });
  }
}

if (require.main !== module) {
  module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new ParcelappAdapter(options);
} else {
  (() => new ParcelappAdapter())();
}
