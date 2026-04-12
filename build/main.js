"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_parcel_client = require("./lib/parcel-client");
var import_state_manager = require("./lib/state-manager");
const MIN_POLL_INTERVAL = 5;
const MAX_POLL_INTERVAL = 60;
const DEFAULT_POLL_INTERVAL = 10;
const MIN_POLL_GAP_MS = 6e4;
class ParcelappAdapter extends utils.Adapter {
  client = null;
  stateManager = null;
  pollTimer = void 0;
  isPolling = false;
  lastPollTime = 0;
  rateLimitedUntil = 0;
  lastErrorCode = "";
  failedDeliveries = /* @__PURE__ */ new Set();
  /** @param options Adapter options */
  constructor(options = {}) {
    super({
      ...options,
      name: "parcelapp"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("unload", this.onUnload.bind(this));
    this.on("message", this.onMessage.bind(this));
  }
  async onReady() {
    var _a;
    await this.setStateAsync("info.connection", { val: false, ack: true });
    const { apiKey } = this.config;
    if (!apiKey || apiKey.trim().length < 10) {
      this.log.error(
        "No valid API key configured \u2014 please enter your parcel.app API key in the adapter settings"
      );
      return;
    }
    this.client = new import_parcel_client.ParcelClient(apiKey.trim());
    this.stateManager = new import_state_manager.StateManager(this);
    await this.cleanupObsoleteStates();
    await this.poll();
    const interval = Math.max(
      MIN_POLL_INTERVAL,
      Math.min(
        MAX_POLL_INTERVAL,
        (_a = this.config.pollInterval) != null ? _a : DEFAULT_POLL_INTERVAL
      )
    );
    const intervalMs = interval * 60 * 1e3;
    this.pollTimer = this.setInterval(() => void this.poll(), intervalMs);
    this.log.info(
      `Parcel tracking started \u2014 polling every ${interval} minutes`
    );
  }
  onUnload(callback) {
    try {
      if (this.pollTimer) {
        this.clearInterval(this.pollTimer);
        this.pollTimer = void 0;
      }
      void this.setState("info.connection", { val: false, ack: true });
    } catch {
    }
    callback();
  }
  async onMessage(obj) {
    var _a;
    if (!(obj == null ? void 0 : obj.command) || !obj.callback) {
      return;
    }
    try {
      switch (obj.command) {
        case "checkConnection": {
          const msg = obj.message;
          const key = ((_a = msg == null ? void 0 : msg.apiKey) == null ? void 0 : _a.trim()) || "";
          if (!key || key.length < 10) {
            this.sendTo(
              obj.from,
              obj.command,
              { success: false, message: "API key is too short" },
              obj.callback
            );
            return;
          }
          const testClient = new import_parcel_client.ParcelClient(key);
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
              obj.callback
            );
            return;
          }
          const request = obj.message;
          const addResult = await this.client.addDelivery(request);
          this.sendTo(obj.from, obj.command, addResult, obj.callback);
          if (addResult.success) {
            void this.poll();
          }
          break;
        }
        default:
          this.sendTo(
            obj.from,
            obj.command,
            { error: "Unknown command" },
            obj.callback
          );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.sendTo(
        obj.from,
        obj.command,
        { success: false, error_message: msg },
        obj.callback
      );
    }
  }
  async cleanupObsoleteStates() {
    const obsoleteStates = [
      "summary.json"
      // removed in 0.2.0
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
  classifyError(error) {
    if (error.code === "RATE_LIMITED") {
      return "RATE_LIMITED";
    }
    if (error.code === "INVALID_API_KEY") {
      return "INVALID_API_KEY";
    }
    if (error.code === "ENOTFOUND" || error.code === "ECONNREFUSED" || error.code === "ECONNRESET" || error.code === "ENETUNREACH" || error.code === "EHOSTUNREACH" || error.code === "EAI_AGAIN") {
      return "NETWORK";
    }
    if (error.message.includes("timeout") || error.code === "ETIMEDOUT") {
      return "TIMEOUT";
    }
    return error.code || "UNKNOWN";
  }
  async poll() {
    if (this.isPolling || !this.client || !this.stateManager) {
      return;
    }
    const now = Date.now();
    if (now < this.rateLimitedUntil) {
      const waitMin = Math.ceil((this.rateLimitedUntil - now) / 6e4);
      this.log.debug(
        `Skipping poll \u2014 rate limited for ${waitMin} more minute(s)`
      );
      return;
    }
    if (now - this.lastPollTime < MIN_POLL_GAP_MS) {
      this.log.debug("Skipping poll \u2014 too soon after last poll");
      return;
    }
    this.isPolling = true;
    this.lastPollTime = now;
    try {
      const autoRemove = this.config.autoRemoveDelivered !== false;
      const deliveries = await this.client.getDeliveries(
        autoRemove ? "active" : "recent"
      );
      this.rateLimitedUntil = 0;
      if (this.lastErrorCode) {
        this.log.info("Connection restored");
        this.lastErrorCode = "";
      }
      await this.setStateAsync("info.connection", { val: true, ack: true });
      const activeDeliveries = deliveries.filter(
        (d) => this.stateManager.parseStatus(d) !== 0
      );
      const visibleDeliveries = autoRemove ? activeDeliveries : deliveries;
      const activeIds = [];
      for (const delivery of visibleDeliveries) {
        try {
          const carrierName = await this.client.getCarrierName(
            delivery.carrier_code
          );
          await this.stateManager.updateDelivery(delivery, carrierName);
          activeIds.push(this.stateManager.packageId(delivery));
          this.failedDeliveries.delete(delivery.tracking_number);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (this.failedDeliveries.has(delivery.tracking_number)) {
            this.log.debug(
              `Failed to update "${delivery.tracking_number}": ${msg}`
            );
          } else {
            this.log.warn(
              `Failed to update "${delivery.tracking_number}": ${msg}`
            );
            this.failedDeliveries.add(delivery.tracking_number);
          }
        }
      }
      await this.stateManager.cleanupDeliveries(activeIds);
      await this.stateManager.updateSummary(activeDeliveries);
      this.log.debug(
        `Polled ${visibleDeliveries.length} deliveries (${activeDeliveries.length} active)`
      );
    } catch (err) {
      const error = err;
      const errorCode = this.classifyError(error);
      const isRepeat = errorCode === this.lastErrorCode;
      this.lastErrorCode = errorCode;
      if (error.code === "RATE_LIMITED") {
        const cooldownSec = error.retryAfterSeconds || 5 * 60;
        this.rateLimitedUntil = Date.now() + cooldownSec * 1e3;
        this.log.warn(
          `Rate limit hit \u2014 pausing API requests for ${Math.ceil(cooldownSec / 60)} minute(s)`
        );
      } else if (error.code === "INVALID_API_KEY") {
        this.log.error(
          "Invalid API key \u2014 please check your parcel.app API key"
        );
      } else if (isRepeat) {
        this.log.debug(`Poll failed (ongoing): ${error.message}`);
      } else if (errorCode === "NETWORK") {
        this.log.warn(`Cannot reach parcel.app API \u2014 will keep retrying`);
      } else if (errorCode === "TIMEOUT") {
        this.log.warn(`API request timeout \u2014 will retry next cycle`);
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
  module.exports = (options) => new ParcelappAdapter(options);
} else {
  (() => new ParcelappAdapter())();
}
//# sourceMappingURL=main.js.map
