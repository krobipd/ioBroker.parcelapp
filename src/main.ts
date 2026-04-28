import * as utils from "@iobroker/adapter-core";
import { ParcelClient } from "./lib/parcel-client";
import { StateManager } from "./lib/state-manager";

const MIN_POLL_INTERVAL = 5;
const MAX_POLL_INTERVAL = 60;
const DEFAULT_POLL_INTERVAL = 10;
const MIN_POLL_GAP_MS = 60_000; // Minimum 60s between polls

/**
 * Extract a log-friendly message from an unknown error value.
 *
 * @param err Value caught in a promise rejection (may or may not be an Error)
 */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
    this.unhandledRejectionHandler = (reason: unknown) => {
      this.log.error(`Unhandled rejection: ${errText(reason)}`);
    };
    this.uncaughtExceptionHandler = (err: Error) => {
      this.log.error(`Uncaught exception: ${errText(err)}`);
    };
    process.on("unhandledRejection", this.unhandledRejectionHandler);
    process.on("uncaughtException", this.uncaughtExceptionHandler);
  }

  private async onReady(): Promise<void> {
    await this.setStateAsync("info.connection", { val: false, ack: true });

    // Validate config
    const { apiKey } = this.config;
    if (!apiKey || apiKey.trim().length < 10) {
      this.log.error("No valid API key configured — please enter your parcel.app API key in the adapter settings");
      return;
    }

    // Pick the label language from the ioBroker system configuration.
    // StateManager falls back to English if the language is unsupported.
    const sysConfig = await this.getForeignObjectAsync("system.config");
    const language = (sysConfig?.common as { language?: string } | undefined)?.language ?? "";

    // Initialize
    this.client = new ParcelClient(apiKey.trim());
    this.stateManager = new StateManager(this, language);

    // Cleanup obsolete states
    await this.cleanupObsoleteStates();

    // Initial poll
    await this.poll();

    // Set up recurring poll
    const interval = Math.max(
      MIN_POLL_INTERVAL,
      Math.min(MAX_POLL_INTERVAL, this.config.pollInterval ?? DEFAULT_POLL_INTERVAL),
    );
    const intervalMs = interval * 60 * 1000;
    this.pollTimer = this.setInterval(() => void this.poll(), intervalMs);

    this.log.info(`Parcel tracking started — polling every ${interval} minutes`);
  }

  private onUnload(callback: () => void): void {
    try {
      if (this.pollTimer) {
        this.clearInterval(this.pollTimer);
        this.pollTimer = undefined;
      }
      if (this.unhandledRejectionHandler) {
        process.off("unhandledRejection", this.unhandledRejectionHandler);
        this.unhandledRejectionHandler = null;
      }
      if (this.uncaughtExceptionHandler) {
        process.off("uncaughtException", this.uncaughtExceptionHandler);
        this.uncaughtExceptionHandler = null;
      }
      void this.setState("info.connection", { val: false, ack: true });
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
          if (!key || key.length < 10) {
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
      const msg = err instanceof Error ? err.message : String(err);
      this.sendTo(obj.from, obj.command, { success: false, error_message: msg }, obj.callback);
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

      // Update each delivery (isolated: one failure must not block others)
      const activeIds: string[] = [];
      for (const delivery of visibleDeliveries) {
        try {
          const carrierName = await this.client.getCarrierName(delivery.carrier_code);
          await this.stateManager.updateDelivery(delivery, carrierName);
          activeIds.push(this.stateManager.packageId(delivery));
          this.failedDeliveries.delete(delivery.tracking_number);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (this.failedDeliveries.has(delivery.tracking_number)) {
            this.log.debug(`Failed to update "${delivery.tracking_number}": ${msg}`);
          } else {
            this.log.warn(`Failed to update "${delivery.tracking_number}": ${msg}`);
            this.failedDeliveries.add(delivery.tracking_number);
          }
        }
      }

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
        const cooldownSec = error.retryAfterSeconds || 5 * 60;
        this.rateLimitedUntil = Date.now() + cooldownSec * 1000;
        this.log.warn(`Rate limit hit — pausing API requests for ${Math.ceil(cooldownSec / 60)} minute(s)`);
      } else if (error.code === "INVALID_API_KEY") {
        // Always log — user must fix config
        this.log.error("Invalid API key — please check your parcel.app API key");
      } else if (isRepeat) {
        // Same error as last time — don't spam the log
        this.log.debug(`Poll failed (ongoing): ${error.message}`);
      } else if (errorCode === "NETWORK") {
        this.log.warn(`Cannot reach parcel.app API — will keep retrying`);
      } else if (errorCode === "TIMEOUT") {
        this.log.warn(`API request timeout — will retry next cycle`);
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
