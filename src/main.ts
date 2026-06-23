import * as utils from "@iobroker/adapter-core";
import { I18n } from "@iobroker/adapter-core";
import { join } from "node:path";
import { coerceClampedInt, errText, oneLine } from "./lib/coerce";
import { ParcelClient } from "./lib/parcel-client";
import { resolveLanguage, StateManager } from "./lib/state-manager";
import type { AddDeliveryRequest } from "./lib/types";

const MIN_POLL_INTERVAL = 5;
const MAX_POLL_INTERVAL = 60;
const DEFAULT_POLL_INTERVAL = 10;
const MIN_POLL_GAP_MS = 60_000; // Minimum 60s between polls
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
 * ioBroker adapter for parcel.app package tracking. Exported so the
 * orchestration unit tests can drive its lifecycle/poll handlers directly.
 */
export class ParcelappAdapter extends utils.Adapter {
  private client: ParcelClient | null = null;
  private stateManager: StateManager | null = null;
  /**
   * Factories for the HTTP client + state manager — default to the real
   * constructors. Test seams (fleet pattern): unit tests replace these with
   * fakes to exercise the poll orchestration (throttle/force/rate-limit
   * interplay, error routing, failure dedup) without real network.
   *
   * @param apiKey parcel.app API key
   */
  private makeClient: (apiKey: string) => ParcelClient = apiKey =>
    new ParcelClient(apiKey, { debug: (m: string) => this.log.debug(m) });
  /** @param language Raw system language (resolution happens in StateManager) */
  private makeStateManager: (language: string) => StateManager = language => new StateManager(this, language);
  private pollTimer: ioBroker.Interval | undefined = undefined;
  private isPolling = false;
  private lastPollTime = 0;
  private rateLimitedUntil = 0;
  private lastErrorCode = "";
  /**
   * Package ids (not raw tracking numbers) whose last updateDelivery failed.
   * Keyed like the states so the dedup survives a sanitize collision or a
   * missing tracking number; pruned each poll against the visible pkgIds.
   */
  private failedDeliveries = new Set<string>();
  /** Timestamps of recent addDelivery POSTs — the S4 throttle window. */
  private addTimestamps: number[] = [];
  /**
   * v0.4.4: short-lived test-clients spawned from `checkConnection` admin
   * messages. The prod-`this.client` is what `onUnload` cancels, so these
   * need their own registry to be reachable at shutdown. Without this, an
   * admin clicking "Test Connection" right before adapter-stop could keep
   * the process alive past js-controller's 4-second kill deadline.
   */
  private testClients = new Set<ParcelClient>();

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
      await I18n.init(join(this.adapterDir, "admin"), this);
      this.log.debug(
        `onReady: starting (pollInterval=${JSON.stringify(this.config.pollInterval)}, autoRemoveDelivered=${this.config.autoRemoveDelivered})`,
      );

      const sysConfig = await this.getForeignObjectAsync("system.config");
      const language = (sysConfig?.common as { language?: string } | undefined)?.language ?? "";
      // v0.7.2: the fallback resolution lives in StateManager (resolveLanguage)
      // — log the value that is actually used, not a dead local field.
      this.log.debug(`system language: '${language}' → using '${resolveLanguage(language)}'`);

      await this.setStateAsync("info.connection", { val: false, ack: true });

      const { apiKey } = this.config;
      if (!apiKey || apiKey.trim().length < MIN_API_KEY_LENGTH) {
        this.log.error("No valid API key configured — please enter your parcel.app API key in the adapter settings");
        return;
      }

      this.client = this.makeClient(apiKey.trim());
      this.stateManager = this.makeStateManager(language);

      try {
        await this.cleanupObsoleteStates();
      } catch (err) {
        // C8: a cleanup failure must not abort startup. Without this guard the
        // outer catch would skip arming the poll interval below, and the adapter
        // would never poll until a manual restart. Degrade to a warning.
        this.log.warn(`cleanupObsoleteStates failed (continuing): ${errText(err)}`);
      }

      await this.poll();

      const interval = ParcelappAdapter.coercePollInterval(this.config.pollInterval);
      this.log.debug(`pollInterval: raw=${JSON.stringify(this.config.pollInterval)} resolved=${interval}min`);
      const intervalMs = interval * 60 * 1000;
      this.pollTimer = this.setInterval(() => {
        void this.poll().catch(err => this.log.error(`Scheduled poll failed: ${errText(err)}`));
      }, intervalMs);

      this.log.info(`Parcel tracking started — polling every ${interval} minutes`);
    } catch (err: unknown) {
      this.log.error(`onReady failed: ${errText(err)}`);
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
    try {
      if (this.pollTimer) {
        this.clearInterval(this.pollTimer);
        this.pollTimer = undefined;
      }
      // v0.4.2 (M11+P1): cancel every in-flight HTTPS request so a slow
      // parcel.app endpoint doesn't keep the adapter alive past
      // js-controller's 4-second kill deadline.
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
      this.log.debug(`onUnload error (ignored): ${errText(err)}`);
    }
    callback();
  }

  private async onMessage(obj: ioBroker.Message): Promise<void> {
    // v0.4.3 (F1): entry log BEFORE the early-return — broadcast messages
    // without callback wouldn't be visible otherwise.
    this.log.debug(`onMessage: command='${obj?.command}' from='${obj?.from}' has-callback=${!!obj?.callback}`);
    if (!obj?.command || !obj.callback) {
      return;
    }

    try {
      switch (obj.command) {
        case "checkConnection": {
          const msg = obj.message as { apiKey?: string };
          const key = msg?.apiKey?.trim() || "";
          if (!key || key.length < MIN_API_KEY_LENGTH) {
            // v0.4.3 (F2): trace the reject before sendTo.
            this.log.debug("checkConnection: apiKey too short");
            this.sendTo(obj.from, obj.command, { success: false, message: "API key is too short" }, obj.callback);
            return;
          }
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
            this.sendTo(obj.from, obj.command, result, obj.callback);
          } finally {
            this.testClients.delete(testClient);
          }
          break;
        }
        case "addDelivery": {
          if (!this.client) {
            // v0.4.3 (F4): trace addDelivery-before-init.
            this.log.debug("addDelivery: adapter not initialized");
            this.sendTo(
              obj.from,
              obj.command,
              { success: false, error_message: "Adapter not initialized" },
              obj.callback,
            );
            return;
          }
          // v0.7.2: obj.message is `unknown`-shaped — a script calling
          // sendTo("parcelapp", "addDelivery", null) used to surface as an
          // ugly TypeError through the catch instead of a clear validation
          // message. Coerce to a plain object and validate required fields.
          const raw = obj.message;
          const msg =
            raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
          if (
            typeof msg.tracking_number !== "string" ||
            msg.tracking_number.length === 0 ||
            typeof msg.carrier_code !== "string" ||
            msg.carrier_code.length === 0 ||
            typeof msg.description !== "string" ||
            msg.description.length === 0
          ) {
            this.log.debug("addDelivery: missing tracking_number/carrier_code/description in message");
            this.sendTo(
              obj.from,
              obj.command,
              { success: false, error_message: "tracking_number, carrier_code and description are required" },
              obj.callback,
            );
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
            this.sendTo(
              obj.from,
              obj.command,
              { success: false, error_message: `each field must be at most ${MAX_ADD_FIELD_LEN} characters` },
              obj.callback,
            );
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
            this.log.warn(
              `addDelivery throttled: more than ${MAX_ADDS_PER_WINDOW} requests within ${ADD_WINDOW_MS / 1000}s`,
            );
            this.sendTo(
              obj.from,
              obj.command,
              {
                success: false,
                error_message: `too many addDelivery requests; max ${MAX_ADDS_PER_WINDOW} per ${ADD_WINDOW_MS / 1000}s`,
              },
              obj.callback,
            );
            return;
          }
          this.addTimestamps.push(nowMs);
          const addResult = await this.client.addDelivery(request);
          // v0.4.3 (F5): trace addDelivery result with the tracking number.
          this.log.debug(`addDelivery: '${request.tracking_number}' result=${addResult.success ? "ok" : "fail"}`);
          this.sendTo(obj.from, obj.command, addResult, obj.callback);
          if (addResult.success) {
            // C5: force bypasses the 60s throttle so the next poll runs right
            // away; the rate-limit cooldown still applies. Note: the GET returns
            // a cached list and a newly added package has no tracking data for
            // ~45-90 min, so this poll usually won't surface it yet.
            void this.poll({ force: true }).catch(err =>
              this.log.error(`Poll after addDelivery failed: ${errText(err)}`),
            );
          }
          break;
        }
        default:
          // v0.4.3 (F6): trace unknown command before sendTo.
          this.log.debug(`onMessage: unknown command '${obj.command}'`);
          this.sendTo(obj.from, obj.command, { error: "Unknown command" }, obj.callback);
      }
    } catch (err) {
      // v0.4.3 (F7): trace catch so the debug log shows what failed.
      // The sendTo back to the caller is preserved unchanged.
      this.log.debug(`onMessage: '${obj.command}' failed: ${errText(err)}`);
      this.sendTo(obj.from, obj.command, { success: false, error_message: errText(err) }, obj.callback);
    }
  }

  private async cleanupObsoleteStates(): Promise<void> {
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
   * @param error The error to classify
   */
  private classifyError(error: Error & { code?: string }): string {
    if (error.code === "RATE_LIMITED") {
      return "RATE_LIMITED";
    }
    if (error.code === "INVALID_API_KEY") {
      return "INVALID_API_KEY";
    }
    // v0.4.2 (P3): 403 is a permission issue, distinct from invalid api-key.
    if (error.code === "FORBIDDEN") {
      return "FORBIDDEN";
    }
    // Network errors: DNS, connection refused, no internet
    if (
      error.code === "ENOTFOUND" ||
      error.code === "ECONNREFUSED" ||
      error.code === "ECONNRESET" ||
      error.code === "ENETUNREACH" ||
      error.code === "EHOSTUNREACH" ||
      error.code === "EAI_AGAIN"
    ) {
      return "NETWORK";
    }
    if (error.message.includes("timeout") || error.code === "ETIMEDOUT") {
      return "TIMEOUT";
    }
    return error.code || "UNKNOWN";
  }

  private async poll(options: { force?: boolean } = {}): Promise<void> {
    if (this.isPolling || !this.client || !this.stateManager) {
      return;
    }

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

    // Throttle: minimum gap between polls. A forced poll (e.g. from
    // addDelivery) bypasses this so a freshly added package shows up
    // immediately; the rate-limit cooldown above still applies to protect
    // the API.
    if (!options.force && now - this.lastPollTime < MIN_POLL_GAP_MS) {
      this.log.debug("Skipping poll — too soon after last poll");
      return;
    }

    this.isPolling = true;
    this.lastPollTime = now;
    try {
      // When keeping delivered packages, use "recent" to get them from API
      const deliveries = await this.client.getDeliveries(autoRemoveMode ? "active" : "recent");

      // Reset error state on success
      this.rateLimitedUntil = 0;
      if (this.lastErrorCode) {
        this.log.info("Connection restored");
        this.lastErrorCode = "";
      }
      await this.setStateChangedAsync("info.connection", { val: true, ack: true });

      // Split into active (non-delivered) and visible (what gets states)
      const activeDeliveries = deliveries.filter(d => this.stateManager!.parseStatus(d) !== 0);
      const visibleDeliveries = autoRemoveMode ? activeDeliveries : deliveries;

      // v0.4.2 (S3): reset the per-poll collision tracker, then compute every
      // package id in a deterministic sequential pre-pass (stable array order)
      // BEFORE the parallel updates — collision-suffixing is then deterministic
      // and packageId runs exactly once per delivery instead of twice.
      this.stateManager.resetPollState();
      const pkgIds = visibleDeliveries.map(d => this.stateManager!.packageId(d));

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
              this.log.debug(`updateDelivery: '${tracking}' carrier=${carrier} status=${delivery.status_code}`);
              const carrierName = await this.client!.getCarrierName(delivery.carrier_code);
              await this.stateManager!.updateDelivery(delivery, carrierName, pkgId);
              this.failedDeliveries.delete(pkgId);
            } catch (err) {
              const msg = errText(err);
              if (this.failedDeliveries.has(pkgId)) {
                this.log.debug(`Failed to update '${tracking}': ${msg}`);
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
      await this.stateManager.cleanupDeliveries(pkgIds);

      // Update summary (always uses active/non-delivered)
      await this.stateManager.updateSummary(activeDeliveries);

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
      const error = err as Error & {
        code?: string;
        retryAfterSeconds?: number;
      };

      // Classify the error
      const errorCode = this.classifyError(error);
      const isRepeat = errorCode === this.lastErrorCode;
      this.lastErrorCode = errorCode;

      if (error.code === "RATE_LIMITED") {
        // v0.4.2 (M9): clamp Retry-After value into [60s, 24h]. A bogus 0,
        // negative, or fractional value used to either wipe the cooldown
        // (set rateLimitedUntil to past) or set it for fractions of a
        // second — neither is the intended behavior.
        const rawCooldown = error.retryAfterSeconds ?? 0;
        const cooldownSec =
          Number.isFinite(rawCooldown) && rawCooldown > 0
            ? Math.min(24 * 3600, Math.max(60, Math.floor(rawCooldown)))
            : 5 * 60;
        this.rateLimitedUntil = Date.now() + cooldownSec * 1000;
        this.log.warn(`Rate limit hit — pausing API requests for ${Math.ceil(cooldownSec / 60)} minute(s)`);
      } else if (error.code === "FORBIDDEN") {
        // v0.4.2 (P3): 403 is a permission issue (e.g. Premium subscription
        // expired). Reauth wouldn't help — surface a clear hint.
        this.log.error(
          "parcel.app returned 403 Forbidden — your account may not have an active Premium subscription, or the API key was revoked. Check your account on parcelapp.net.",
        );
      } else if (error.code === "INVALID_API_KEY") {
        // Always log — user must fix config
        this.log.error("Invalid API key — please check your parcel.app API key");
      } else if (isRepeat) {
        // Same error as last time — don't spam the log
        this.log.debug(`Poll failed (ongoing): ${error.message}`);
      } else if (errorCode === "NETWORK") {
        this.log.warn("Cannot reach parcel.app API — will keep retrying");
      } else if (errorCode === "TIMEOUT") {
        this.log.warn("API request timeout — will retry next cycle");
      } else {
        this.log.error(`Poll failed: ${error.message}`);
      }

      // C2: setStateChangedAsync avoids redundant `false` writes on sustained
      // failure. The `.catch` keeps poll() from rejecting when the broker is
      // already down, so the fire-and-forget callers never see an unhandled
      // rejection (no global process handler needed).
      await this.setStateChangedAsync("info.connection", { val: false, ack: true }).catch(() => {
        /* broker shutting down — ignore */
      });
    } finally {
      this.isPolling = false;
    }
  }
}

if (require.main !== module) {
  module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new ParcelappAdapter(options);
} else {
  (() => new ParcelappAdapter())();
}
