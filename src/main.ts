import * as utils from "@iobroker/adapter-core";
import { ParcelClient } from "./lib/parcel-client";
import { StateManager } from "./lib/state-manager";
import "./lib/types";

const MIN_POLL_INTERVAL = 5;
const MAX_POLL_INTERVAL = 60;
const DEFAULT_POLL_INTERVAL = 10;

/** ioBroker adapter for parcel.app package tracking */
class ParcelappAdapter extends utils.Adapter {
  private client: ParcelClient | null = null;
  private stateManager: StateManager | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private isPolling = false;

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
    await this.setStateAsync("info.connection", { val: false, ack: true });

    // Validate config
    const { apiKey } = this.config;
    if (!apiKey || apiKey.trim().length < 10) {
      this.log.error(
        "No valid API key configured — please enter your parcel.app API key in the adapter settings",
      );
      return;
    }

    // Initialize
    this.client = new ParcelClient(apiKey.trim());
    this.stateManager = new StateManager(this);

    // Initial poll
    await this.poll();

    // Set up recurring poll
    const interval = Math.max(
      MIN_POLL_INTERVAL,
      Math.min(
        MAX_POLL_INTERVAL,
        this.config.pollInterval ?? DEFAULT_POLL_INTERVAL,
      ),
    );
    const intervalMs = interval * 60 * 1000;
    this.pollTimer = setInterval(() => void this.poll(), intervalMs);

    this.log.info(
      `Parcel tracking started — polling every ${interval} minutes`,
    );
  }

  private onUnload(callback: () => void): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    void this.setState("info.connection", { val: false, ack: true });
    callback();
  }

  private async onMessage(obj: ioBroker.Message): Promise<void> {
    if (!obj?.command) {
      return;
    }

    switch (obj.command) {
      case "checkConnection": {
        const msg = obj.message as { apiKey?: string };
        const key = msg?.apiKey?.trim() || "";
        if (!key || key.length < 10) {
          this.sendTo(
            obj.from,
            obj.command,
            {
              success: false,
              message: "API key is too short",
            },
            obj.callback,
          );
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
            {
              success: false,
              error_message: "Adapter not initialized",
            },
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
          // Trigger immediate poll to pick up the new delivery
          void this.poll();
        }
        break;
      }
      default:
        this.sendTo(
          obj.from,
          obj.command,
          { error: "Unknown command" },
          obj.callback,
        );
    }
  }

  private async poll(): Promise<void> {
    if (this.isPolling || !this.client || !this.stateManager) {
      return;
    }

    this.isPolling = true;
    try {
      const filterMode = this.config.filterMode || "active";
      const deliveries = await this.client.getDeliveries(filterMode);

      await this.setStateAsync("info.connection", { val: true, ack: true });

      // Filter active deliveries (exclude delivered)
      const activeDeliveries = deliveries.filter(
        (d) => parseInt(d.status_code, 10) !== 0,
      );

      // Update each delivery
      const activeIds: string[] = [];
      for (const delivery of activeDeliveries) {
        const carrierName = await this.client.getCarrierName(
          delivery.carrier_code,
        );
        await this.stateManager.updateDelivery(delivery, carrierName);
        activeIds.push(this.stateManager.packageId(delivery));
      }

      // Cleanup stale deliveries
      await this.stateManager.cleanupDeliveries(activeIds);

      // Update summary (already filtered — no re-filtering needed)
      await this.stateManager.updateSummary(activeDeliveries);

      this.log.debug(`Polled ${activeDeliveries.length} active deliveries`);
    } catch (err) {
      const error = err as Error & { code?: string };

      if (error.code === "INVALID_API_KEY") {
        this.log.error(
          "Invalid API key — please check your parcel.app API key",
        );
      } else if (error.message.includes("timeout")) {
        this.log.error(`API request timeout: ${error.message}`);
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
  module.exports = (options: Partial<utils.AdapterOptions> | undefined) =>
    new ParcelappAdapter(options);
} else {
  (() => new ParcelappAdapter())();
}
