import * as utils from "@iobroker/adapter-core";
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
  private unhandledRejectionHandler: ((reason: unknown) => void) | null = null;
  private uncaughtExceptionHandler: ((err: Error) => void) | null = null;
  /** ioBroker system language — read once in `onReady` from `system.config`. EN fallback. */
  private systemLang: string = "en";

  /** @param options Adapter options */
  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({
      ...options,
      name: "parcelapp",
    });
    // Wrap async handlers with .catch() so a rejection can never become an
    // unhandled promise rejection (which would SIGKILL the adapter and trap
    // js-controller in a restart loop without any stack trace).
    this.on("ready", () => {
      this.onReady().catch(err => this.log.error(`onReady failed: ${errText(err)}`));
    });
    this.on("unload", this.onUnload.bind(this));
    this.on("message", obj => {
      this.onMessage(obj).catch(err => this.log.error(`onMessage failed: ${errText(err)}`));
    });
    // Last-line-of-defence against unhandled rejections / sync throws from
    // fire-and-forget paths (e.g. `void this.poll()`). The per-handler
    // .catch() wrappers cover the documented async paths; this catches
    // anything that slips past during refactors.
    // v0.4.2 (M1): log + terminate(11) instead of leaving the process alive
    // in an undefined state. The per-handler wrappers cover expected paths;
    // anything reaching here is by definition unexpected.
    this.unhandledRejectionHandler = (reason: unknown) => {
      this.log.error(`Unhandled rejection: ${errText(reason)}`);
      this.terminate?.(11);
    };
    this.uncaughtExceptionHandler = (err: Error) => {
      this.log.error(`Uncaught exception: ${errText(err)}`);
      this.terminate?.(11);
    };
    process.on("unhandledRejection", this.unhandledRejectionHandler);
    process.on("uncaughtException", this.uncaughtExceptionHandler);
  }

  private async onReady(): Promise<void> {
    // Pick the system language up-front so all user-facing logs go out in the
    // user's language. StateManager also gets it for state-name localization.
    const sysConfig = await this.getForeignObjectAsync("system.config");
    const language = (sysConfig?.common as { language?: string } | undefined)?.language ?? "";
    if (typeof language === "string" && language.length > 0) {
      this.systemLang = language;
    }

    await this.setStateAsync("info.connection", { val: false, ack: true });

    // Validate config
    const { apiKey } = this.config;
    if (!apiKey || apiKey.trim().length < MIN_API_KEY_LENGTH) {
      this.log.error("No valid API key configured — please enter your parcel.app API key in the adapter settings");
      return;
    }

    // Initialize
    this.client = new ParcelClient(apiKey.trim());
    this.stateManager = new StateManager(this, language);

    // Cleanup obsolete states
    await this.cleanupObsoleteStates();

    // Initial poll
    await this.poll();

    // v0.4.2 (M5): coerce explicitly. Admin can store `pollInterval` as a
    // string; `Math.min(60, "10")` happens to coerce, but `Math.max(5,
    // undefined)` returns NaN, and `setInterval(fn, NaN)` becomes
    // `setInterval(fn, 0)` — a tight loop that hammers the API.
    const interval = ParcelappAdapter.coercePollInterval(this.config.pollInterval);
    const intervalMs = interval * 60 * 1000;
    this.pollTimer = this.setInterval(() => void this.poll(), intervalMs);

    this.log.info(`Parcel tracking started — polling every ${interval} minutes`);
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
      if (this.unhandledRejectionHandler) {
        process.off("unhandledRejection", this.unhandledRejectionHandler);
        this.unhandledRejectionHandler = null;
      }
      if (this.uncaughtExceptionHandler) {
        process.off("uncaughtException", this.uncaughtExceptionHandler);
        this.uncaughtExceptionHandler = null;
      }
      // v0.4.2 (M10): explicit `.catch(() => {})` on the fire-and-forget so
      // a broker-already-down doesn't leak as an unhandled rejection.
      void this.setState("info.connection", { val: false, ack: true }).catch(() => {
        /* broker is shutting down — ignore */
      });
    } catch {
      // ignore
    }
    callback();
  }

  private async onMessage(obj: ioBroker.Message): Promise<void> {
    if (!obj?.command || !obj.callback) {
      return;
    }

    try {
      switch (obj.command) {
        case "checkConnection": {
          const msg = obj.message as { apiKey?: string };
          const key = msg?.apiKey?.trim() || "";
          if (!key || key.length < MIN_API_KEY_LENGTH) {
            this.sendTo(obj.from, obj.command, { success: false, message: "API key is too short" }, obj.callback);
            return;
          }
          const testClient = new ParcelClient(key);
          const result = await testClient.testConnection();
          this.sendTo(obj.from, obj.command, result, obj.callback);
          break;
        }
        case "addDelivery": {
          if (!this.client) {
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
          this.sendTo(obj.from, obj.command, addResult, obj.callback);
          if (addResult.success) {
            void this.poll();
          }
          break;
        }
        default:
          this.sendTo(obj.from, obj.command, { error: "Unknown command" }, obj.callback);
      }
    } catch (err) {
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

  private async poll(): Promise<void> {
    if (this.isPolling || !this.client || !this.stateManager) {
      return;
    }

    const now = Date.now();

    // Skip if rate limited
    if (now < this.rateLimitedUntil) {
      const waitMin = Math.ceil((this.rateLimitedUntil - now) / 60_000);
      this.log.debug(`Skipping poll — rate limited for ${waitMin} more minute(s)`);
      return;
    }

    // Throttle: minimum gap between polls
    if (now - this.lastPollTime < MIN_POLL_GAP_MS) {
      this.log.debug("Skipping poll — too soon after last poll");
      return;
    }

    this.isPolling = true;
    this.lastPollTime = now;
    try {
      // When keeping delivered packages, use "recent" to get them from API
      const autoRemove = this.config.autoRemoveDelivered !== false;
      const deliveries = await this.client.getDeliveries(autoRemove ? "active" : "recent");

      // Reset error state on success
      this.rateLimitedUntil = 0;
      if (this.lastErrorCode) {
        this.log.info("Connection restored");
        this.lastErrorCode = "";
      }
      await this.setStateAsync("info.connection", { val: true, ack: true });

      // Split into active (non-delivered) and visible (what gets states)
      const activeDeliveries = deliveries.filter(d => this.stateManager!.parseStatus(d) !== 0);
      const visibleDeliveries = autoRemove ? activeDeliveries : deliveries;

      // v0.4.2 (S3): reset per-poll collision tracker so the bare-id wins
      // for the first occurrence in this poll (deterministic, back-compat).
      this.stateManager.resetPollState();

      // v0.4.2 (M4): per-delivery updates run in parallel, each wrapped in
      // try/catch so one bad delivery doesn't poison the others.
      const idResults = await Promise.all(
        visibleDeliveries.map(async delivery => {
          try {
            const carrierName = await this.client!.getCarrierName(delivery.carrier_code);
            await this.stateManager!.updateDelivery(delivery, carrierName);
            this.failedDeliveries.delete(delivery.tracking_number);
            return this.stateManager!.packageId(delivery);
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

      await this.setStateAsync("info.connection", { val: false, ack: true });
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
