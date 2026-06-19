"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var main_exports = {};
__export(main_exports, {
  ParcelappAdapter: () => ParcelappAdapter
});
module.exports = __toCommonJS(main_exports);
var utils = __toESM(require("@iobroker/adapter-core"));
var import_adapter_core = require("@iobroker/adapter-core");
var import_node_path = require("node:path");
var import_coerce = require("./lib/coerce");
var import_parcel_client = require("./lib/parcel-client");
var import_state_manager = require("./lib/state-manager");
const MIN_POLL_INTERVAL = 5;
const MAX_POLL_INTERVAL = 60;
const DEFAULT_POLL_INTERVAL = 10;
const MIN_POLL_GAP_MS = 6e4;
const MIN_API_KEY_LENGTH = 10;
class ParcelappAdapter extends utils.Adapter {
  client = null;
  stateManager = null;
  /**
   * Factories for the HTTP client + state manager — default to the real
   * constructors. Test seams (fleet pattern): unit tests replace these with
   * fakes to exercise the poll orchestration (throttle/force/rate-limit
   * interplay, error routing, failure dedup) without real network.
   *
   * @param apiKey parcel.app API key
   */
  makeClient = (apiKey) => new import_parcel_client.ParcelClient(apiKey, { debug: (m) => this.log.debug(m) });
  /** @param language Raw system language (resolution happens in StateManager) */
  makeStateManager = (language) => new import_state_manager.StateManager(this, language);
  pollTimer = void 0;
  isPolling = false;
  lastPollTime = 0;
  rateLimitedUntil = 0;
  lastErrorCode = "";
  failedDeliveries = /* @__PURE__ */ new Set();
  /**
   * v0.4.4: short-lived test-clients spawned from `checkConnection` admin
   * messages. The prod-`this.client` is what `onUnload` cancels, so these
   * need their own registry to be reachable at shutdown. Without this, an
   * admin clicking "Test Connection" right before adapter-stop could keep
   * the process alive past js-controller's 4-second kill deadline.
   */
  testClients = /* @__PURE__ */ new Set();
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
    var _a, _b;
    try {
      await import_adapter_core.I18n.init((0, import_node_path.join)(this.adapterDir, "admin"), this);
      this.log.debug(
        `onReady: starting (pollInterval=${JSON.stringify(this.config.pollInterval)}, autoRemoveDelivered=${this.config.autoRemoveDelivered})`
      );
      const sysConfig = await this.getForeignObjectAsync("system.config");
      const language = (_b = (_a = sysConfig == null ? void 0 : sysConfig.common) == null ? void 0 : _a.language) != null ? _b : "";
      this.log.debug(`system language: '${language}' \u2192 using '${(0, import_state_manager.resolveLanguage)(language)}'`);
      await this.setStateAsync("info.connection", { val: false, ack: true });
      const { apiKey } = this.config;
      if (!apiKey || apiKey.trim().length < MIN_API_KEY_LENGTH) {
        this.log.error("No valid API key configured \u2014 please enter your parcel.app API key in the adapter settings");
        return;
      }
      this.client = this.makeClient(apiKey.trim());
      this.stateManager = this.makeStateManager(language);
      await this.cleanupObsoleteStates();
      await this.poll();
      const interval = ParcelappAdapter.coercePollInterval(this.config.pollInterval);
      this.log.debug(`pollInterval: raw=${JSON.stringify(this.config.pollInterval)} resolved=${interval}min`);
      const intervalMs = interval * 60 * 1e3;
      this.pollTimer = this.setInterval(() => {
        void this.poll().catch((err) => this.log.error(`Scheduled poll failed: ${(0, import_coerce.errText)(err)}`));
      }, intervalMs);
      this.log.info(`Parcel tracking started \u2014 polling every ${interval} minutes`);
    } catch (err) {
      this.log.error(`onReady failed: ${(0, import_coerce.errText)(err)}`);
    }
  }
  /**
   * v0.4.2 (M5+X5): delegate to the shared `coerceClampedInt` helper.
   *
   * @param raw Raw `pollInterval` from admin config (number or numeric string).
   */
  static coercePollInterval(raw) {
    return (0, import_coerce.coerceClampedInt)(raw, MIN_POLL_INTERVAL, MAX_POLL_INTERVAL, DEFAULT_POLL_INTERVAL);
  }
  onUnload(callback) {
    var _a;
    try {
      if (this.pollTimer) {
        this.clearInterval(this.pollTimer);
        this.pollTimer = void 0;
      }
      (_a = this.client) == null ? void 0 : _a.cancelAll();
      for (const tc of this.testClients) {
        tc.cancelAll();
      }
      this.testClients.clear();
      void this.setState("info.connection", { val: false, ack: true }).catch(() => {
      });
    } catch (err) {
      this.log.debug(`onUnload error (ignored): ${(0, import_coerce.errText)(err)}`);
    }
    callback();
  }
  async onMessage(obj) {
    var _a;
    this.log.debug(`onMessage: command='${obj == null ? void 0 : obj.command}' from='${obj == null ? void 0 : obj.from}' has-callback=${!!(obj == null ? void 0 : obj.callback)}`);
    if (!(obj == null ? void 0 : obj.command) || !obj.callback) {
      return;
    }
    try {
      switch (obj.command) {
        case "checkConnection": {
          const msg = obj.message;
          const key = ((_a = msg == null ? void 0 : msg.apiKey) == null ? void 0 : _a.trim()) || "";
          if (!key || key.length < MIN_API_KEY_LENGTH) {
            this.log.debug("checkConnection: apiKey too short");
            this.sendTo(obj.from, obj.command, { success: false, message: "API key is too short" }, obj.callback);
            return;
          }
          const testClient = this.makeClient(key);
          this.testClients.add(testClient);
          try {
            const result = await testClient.testConnection();
            this.log.debug(`checkConnection: result=${result.success ? "ok" : "fail"} (${result.message})`);
            this.sendTo(obj.from, obj.command, result, obj.callback);
          } finally {
            this.testClients.delete(testClient);
          }
          break;
        }
        case "addDelivery": {
          if (!this.client) {
            this.log.debug("addDelivery: adapter not initialized");
            this.sendTo(
              obj.from,
              obj.command,
              { success: false, error_message: "Adapter not initialized" },
              obj.callback
            );
            return;
          }
          const raw = obj.message;
          const msg = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
          if (typeof msg.tracking_number !== "string" || msg.tracking_number.length === 0 || typeof msg.carrier_code !== "string" || msg.carrier_code.length === 0 || typeof msg.description !== "string" || msg.description.length === 0) {
            this.log.debug("addDelivery: missing tracking_number/carrier_code/description in message");
            this.sendTo(
              obj.from,
              obj.command,
              { success: false, error_message: "tracking_number, carrier_code and description are required" },
              obj.callback
            );
            return;
          }
          const request = {
            tracking_number: msg.tracking_number,
            carrier_code: msg.carrier_code,
            description: msg.description
          };
          if (typeof msg.language === "string" && msg.language.length > 0) {
            request.language = msg.language;
          }
          if (typeof msg.send_push_confirmation === "boolean") {
            request.send_push_confirmation = msg.send_push_confirmation;
          }
          const addResult = await this.client.addDelivery(request);
          this.log.debug(`addDelivery: '${request.tracking_number}' result=${addResult.success ? "ok" : "fail"}`);
          this.sendTo(obj.from, obj.command, addResult, obj.callback);
          if (addResult.success) {
            void this.poll({ force: true }).catch(
              (err) => this.log.error(`Poll after addDelivery failed: ${(0, import_coerce.errText)(err)}`)
            );
          }
          break;
        }
        default:
          this.log.debug(`onMessage: unknown command '${obj.command}'`);
          this.sendTo(obj.from, obj.command, { error: "Unknown command" }, obj.callback);
      }
    } catch (err) {
      this.log.debug(`onMessage: '${obj.command}' failed: ${(0, import_coerce.errText)(err)}`);
      this.sendTo(obj.from, obj.command, { success: false, error_message: (0, import_coerce.errText)(err) }, obj.callback);
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
    if (error.code === "FORBIDDEN") {
      return "FORBIDDEN";
    }
    if (error.code === "ENOTFOUND" || error.code === "ECONNREFUSED" || error.code === "ECONNRESET" || error.code === "ENETUNREACH" || error.code === "EHOSTUNREACH" || error.code === "EAI_AGAIN") {
      return "NETWORK";
    }
    if (error.message.includes("timeout") || error.code === "ETIMEDOUT") {
      return "TIMEOUT";
    }
    return error.code || "UNKNOWN";
  }
  async poll(options = {}) {
    var _a;
    if (this.isPolling || !this.client || !this.stateManager) {
      return;
    }
    const now = Date.now();
    const autoRemoveMode = this.config.autoRemoveDelivered !== false;
    this.log.debug(`poll: starting (autoRemove=${autoRemoveMode}, lastErrorCode='${this.lastErrorCode}')`);
    if (now < this.rateLimitedUntil) {
      const waitMin = Math.ceil((this.rateLimitedUntil - now) / 6e4);
      this.log.debug(`Skipping poll \u2014 rate limited for ${waitMin} more minute(s)`);
      return;
    }
    if (!options.force && now - this.lastPollTime < MIN_POLL_GAP_MS) {
      this.log.debug("Skipping poll \u2014 too soon after last poll");
      return;
    }
    this.isPolling = true;
    this.lastPollTime = now;
    try {
      const deliveries = await this.client.getDeliveries(autoRemoveMode ? "active" : "recent");
      this.rateLimitedUntil = 0;
      if (this.lastErrorCode) {
        this.log.info("Connection restored");
        this.lastErrorCode = "";
      }
      await this.setStateChangedAsync("info.connection", { val: true, ack: true });
      const activeDeliveries = deliveries.filter((d) => this.stateManager.parseStatus(d) !== 0);
      const visibleDeliveries = autoRemoveMode ? activeDeliveries : deliveries;
      this.stateManager.resetPollState();
      const pkgIds = visibleDeliveries.map((d) => this.stateManager.packageId(d));
      const idResults = await Promise.all(
        visibleDeliveries.map(async (delivery, index) => {
          const pkgId = pkgIds[index];
          try {
            this.log.debug(
              `updateDelivery: '${delivery.tracking_number}' carrier=${delivery.carrier_code} status=${delivery.status_code}`
            );
            const carrierName = await this.client.getCarrierName(delivery.carrier_code);
            await this.stateManager.updateDelivery(delivery, carrierName, pkgId);
            this.failedDeliveries.delete(delivery.tracking_number);
            return pkgId;
          } catch (err) {
            const msg = (0, import_coerce.errText)(err);
            if (this.failedDeliveries.has(delivery.tracking_number)) {
              this.log.debug(`Failed to update "${delivery.tracking_number}": ${msg}`);
            } else {
              this.log.warn(`Failed to update '${delivery.tracking_number}': ${msg}`);
              this.failedDeliveries.add(delivery.tracking_number);
            }
            return null;
          }
        })
      );
      const activeIds = idResults.filter((id) => id !== null);
      await this.stateManager.cleanupDeliveries(activeIds);
      await this.stateManager.updateSummary(activeDeliveries);
      const seenTracking = new Set(visibleDeliveries.map((d) => d.tracking_number));
      for (const tracking of [...this.failedDeliveries]) {
        if (!seenTracking.has(tracking)) {
          this.failedDeliveries.delete(tracking);
        }
      }
      this.log.debug(`Polled ${visibleDeliveries.length} deliveries (${activeDeliveries.length} active)`);
    } catch (err) {
      const error = err;
      const errorCode = this.classifyError(error);
      const isRepeat = errorCode === this.lastErrorCode;
      this.lastErrorCode = errorCode;
      if (error.code === "RATE_LIMITED") {
        const rawCooldown = (_a = error.retryAfterSeconds) != null ? _a : 0;
        const cooldownSec = Number.isFinite(rawCooldown) && rawCooldown > 0 ? Math.min(24 * 3600, Math.max(60, Math.floor(rawCooldown))) : 5 * 60;
        this.rateLimitedUntil = Date.now() + cooldownSec * 1e3;
        this.log.warn(`Rate limit hit \u2014 pausing API requests for ${Math.ceil(cooldownSec / 60)} minute(s)`);
      } else if (error.code === "FORBIDDEN") {
        this.log.error(
          "parcel.app returned 403 Forbidden \u2014 your account may not have an active Premium subscription, or the API key was revoked. Check your account on parcelapp.net."
        );
      } else if (error.code === "INVALID_API_KEY") {
        this.log.error("Invalid API key \u2014 please check your parcel.app API key");
      } else if (isRepeat) {
        this.log.debug(`Poll failed (ongoing): ${error.message}`);
      } else if (errorCode === "NETWORK") {
        this.log.warn("Cannot reach parcel.app API \u2014 will keep retrying");
      } else if (errorCode === "TIMEOUT") {
        this.log.warn("API request timeout \u2014 will retry next cycle");
      } else {
        this.log.error(`Poll failed: ${error.message}`);
      }
      await this.setStateChangedAsync("info.connection", { val: false, ack: true }).catch(() => {
      });
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ParcelappAdapter
});
//# sourceMappingURL=main.js.map
