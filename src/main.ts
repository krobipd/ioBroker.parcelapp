import * as utils from "@iobroker/adapter-core";
import { I18n } from "@iobroker/adapter-core";
import { join } from "node:path";
import { coerceClampedInt, errText } from "./lib/coerce";
import { ParcelClient } from "./lib/parcel-client";
import { StateManager } from "./lib/state-manager";

const MIN_POLL_INTERVAL = 5;
const MAX_POLL_INTERVAL = 60;
const DEFAULT_POLL_INTERVAL = 10;
const MIN_POLL_GAP_MS = 60_000; // Minimum 60s between polls
/** v0.4.2 (M6): minimum length for an apiKey value to even be considered valid. */
const MIN_API_KEY_LENGTH = 10;

/** ioBroker adapter for parcel.app package tracking */
class ParcelappAdapter extends utils.Adapter {
  private client: ParcelClient | null = null;
  private stateManager: StateManager | null = null;
  private pollTimer: ioBroker.Interval | undefined = undefined;
  private isPolling = false;
  private lastPollTime = 0;
  private rateLimitedUntil = 0;
  private lastErrorCode = "";
  private failedDeliveries = new Set<string>();
  /**
   * v0.4.4: short-lived test-clients spawned from `checkConnection` admin
   * messages. The prod-`this.client` is what `onUnload` cancels, so these
   * need their own registry to be reachable at shutdown. Without this, an
   * admin clicking "Test Connection" right before adapter-stop could keep
   * the process alive past js-controller's 4-second kill deadline.
   */
  private testClients = new Set<ParcelClient>();
  /** ioBroker system language — read once in `onReady` from `system.config`. EN fallback. */
  private systemLang: string = "en";

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
      if (typeof language === "string" && language.length > 0) {
        this.systemLang = language;
      }
      this.log.debug(`system language: '${language}' → using '${this.systemLang}'`);

      await this.setStateAsync("info.connection", { val: false, ack: true });

      const { apiKey } = this.config;
      if (!apiKey || apiKey.trim().length < MIN_API_KEY_LENGTH) {
        this.log.error("No valid API key configured — please enter your parcel.app API key in the adapter settings");
        return;
      }

      this.client = new ParcelClient(apiKey.trim(), { debug: (m: string) => this.log.debug(m) });
      this.stateManager = new StateManager(this, language);

      await this.cleanupObsoleteStates();

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
          // failures get the same HTTPS-layer trace.
          const testClient = new ParcelClient(key, { debug: (m: string) => this.log.debug(m) });
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
          const request = obj.message as {
            tracking_number: string;
            carrier_code: string;
            description: string;
          };
          const addResult = await this.client.addDelivery(request);
          // v0.4.3 (F5): trace addDelivery result with the tracking number.
          this.log.debug(`addDelivery: '${request?.tracking_number}' result=${addResult.success ? "ok" : "fail"}`);
          this.sendTo(obj.from, obj.command, addResult, obj.callback);
          if (addResult.success) {
            // C5: force bypasses the 60s throttle so the freshly added package
            // shows up immediately; the rate-limit cooldown still applies.
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
      const idResults = await Promise.all(
        visibleDeliveries.map(async (delivery, index) => {
          const pkgId = pkgIds[index];
          try {
            // v0.4.3 (C1): per-delivery entry. ~10 packages × 144 polls/day
            // = ~1440 debug lines/day — acceptable at debug-level. Line stays
            // short (tracking + carrier + status only, no full delivery JSON).
            this.log.debug(
              `updateDelivery: '${delivery.tracking_number}' carrier=${delivery.carrier_code} status=${delivery.status_code}`,
            );
            const carrierName = await this.client!.getCarrierName(delivery.carrier_code);
            await this.stateManager!.updateDelivery(delivery, carrierName, pkgId);
            this.failedDeliveries.delete(delivery.tracking_number);
            return pkgId;
          } catch (err) {
            const msg = errText(err);
            if (this.failedDeliveries.has(delivery.tracking_number)) {
              this.log.debug(`Failed to update "${delivery.tracking_number}": ${msg}`);
            } else {
              this.log.warn(`Failed to update '${delivery.tracking_number}': ${msg}`);
              this.failedDeliveries.add(delivery.tracking_number);
            }
            return null;
          }
        }),
      );
      const activeIds = idResults.filter((id): id is string => id !== null);

      // Cleanup stale deliveries
      await this.stateManager.cleanupDeliveries(activeIds);

      // Update summary (always uses active/non-delivered)
      await this.stateManager.updateSummary(activeDeliveries);

      // Keep failedDeliveries bounded: drop entries for trackings no longer
      // present, so packages that vanish from the API don't linger forever.
      const seenTracking = new Set(visibleDeliveries.map(d => d.tracking_number));
      for (const tracking of [...this.failedDeliveries]) {
        if (!seenTracking.has(tracking)) {
          this.failedDeliveries.delete(tracking);
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
