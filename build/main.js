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
var import_types = require("./lib/types");
const MIN_POLL_INTERVAL = 5;
const MAX_POLL_INTERVAL = 60;
const DEFAULT_POLL_INTERVAL = 10;
const MIN_POLL_GAP_MS = 6e4;
const MIN_API_KEY_LENGTH = 10;
const MAX_ADD_FIELD_LEN = 512;
const UPDATE_BATCH_SIZE = 25;
const MAX_ADDS_PER_WINDOW = 20;
const ADD_WINDOW_MS = 6e4;
const NETWORK_ERROR_CODES = /* @__PURE__ */ new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "EPIPE",
  "ECONNABORTED",
  "EPROTO"
]);
class ParcelappAdapter extends utils.Adapter {
  client = null;
  stateManager = null;
  /**
   * Factories for the HTTP client + state manager — default to the real
   * constructors. Test seams (fleet pattern): unit tests replace these with
   * fakes to exercise the poll orchestration (throttle/rate-limit interplay,
   * error routing, failure dedup) without real network.
   *
   * @param apiKey parcel.app API key
   */
  makeClient = (apiKey) => new import_parcel_client.ParcelClient(apiKey, { debug: (m) => this.log.debug(m) });
  makeStateManager = () => new import_state_manager.StateManager(this);
  pollTimer = void 0;
  isPolling = false;
  lastPollTime = 0;
  rateLimitedUntil = 0;
  lastErrorCode = "";
  /**
   * v0.10.0 (L2): set in onUnload. onReady checks it after its awaits so a
   * stop during the first poll can no longer arm the interval or log
   * "started" after the unload already ran; batch failures during shutdown
   * degrade to debug.
   */
  unloaded = false;
  /**
   * Package ids (not raw tracking numbers) whose last updateDelivery failed.
   * Keyed like the states so the dedup survives a sanitize collision or a
   * missing tracking number; pruned each poll against the visible pkgIds.
   */
  failedDeliveries = /* @__PURE__ */ new Set();
  /** Timestamps of recent addDelivery POSTs — the S4 throttle window. */
  addTimestamps = [];
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
    try {
      await import_adapter_core.I18n.init((0, import_node_path.join)(this.adapterDir, "admin"), this);
      this.log.debug(`onReady: starting (autoRemoveDelivered=${this.config.autoRemoveDelivered})`);
      await this.setState("info.connection", { val: false, ack: true });
      const { apiKey } = this.config;
      if (!apiKey || apiKey.trim().length < MIN_API_KEY_LENGTH) {
        this.log.error("No valid API key configured \u2014 please enter your parcel.app API key in the adapter settings");
        return;
      }
      this.client = this.makeClient(apiKey.trim());
      this.stateManager = this.makeStateManager();
      try {
        await this.cleanupObsoleteStates();
      } catch (err) {
        this.log.warn(`cleanupObsoleteStates failed (continuing): ${(0, import_coerce.errText)(err)}`);
      }
      await this.poll();
      if (this.unloaded) {
        return;
      }
      const interval = ParcelappAdapter.coercePollInterval(this.config.pollInterval);
      this.log.debug(`pollInterval: raw=${JSON.stringify(this.config.pollInterval)} resolved=${interval}min`);
      const intervalMs = interval * 60 * 1e3;
      this.pollTimer = this.setInterval(() => {
        void this.poll().catch((err) => this.log.error(`Scheduled poll failed: ${(0, import_coerce.errText)(err)}`));
      }, intervalMs);
      this.log.info(`Parcel tracking started \u2014 polling every ${interval} minutes`);
    } catch (err) {
      this.log.error(`onReady failed: ${(0, import_coerce.errText)(err)}`);
      if (!this.unloaded) {
        this.terminate("startup failed \u2014 requesting restart", utils.EXIT_CODES.START_IMMEDIATELY_AFTER_STOP);
      }
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
    this.unloaded = true;
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
      try {
        this.log.debug(`onUnload error (ignored): ${(0, import_coerce.errText)(err)}`);
      } catch {
      }
    } finally {
      callback();
    }
  }
  async onMessage(obj) {
    var _a, _b;
    try {
      this.log.debug(
        `onMessage: command='${(0, import_coerce.oneLine)(String((_a = obj == null ? void 0 : obj.command) != null ? _a : ""))}' from='${obj == null ? void 0 : obj.from}' has-callback=${!!(obj == null ? void 0 : obj.callback)}`
      );
      if (!(obj == null ? void 0 : obj.command) || !obj.callback) {
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
          this.log.debug(`onMessage: unknown command '${(0, import_coerce.oneLine)(String(obj.command))}'`);
          this.sendTo(obj.from, obj.command, { error: "Unknown command" }, obj.callback);
      }
    } catch (err) {
      try {
        this.log.debug(`onMessage: '${(0, import_coerce.oneLine)(String((_b = obj == null ? void 0 : obj.command) != null ? _b : ""))}' failed: ${(0, import_coerce.errText)(err)}`);
        if (obj == null ? void 0 : obj.callback) {
          const reply = obj.command === "checkConnection" ? { error: (0, import_coerce.errText)(err) } : { success: false, error_message: (0, import_coerce.errText)(err) };
          this.sendTo(obj.from, obj.command, reply, obj.callback);
        }
      } catch {
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
  async handleCheckConnection(obj) {
    var _a;
    const msg = obj.message;
    const key = ((_a = msg == null ? void 0 : msg.apiKey) == null ? void 0 : _a.trim()) || "";
    if (!key || key.length < MIN_API_KEY_LENGTH) {
      this.log.debug("checkConnection: apiKey too short");
      this.sendTo(obj.from, obj.command, { error: "API key is too short" }, obj.callback);
      return;
    }
    const testClient = this.makeClient(key);
    this.testClients.add(testClient);
    try {
      const result = await testClient.testConnection();
      this.log.debug(`checkConnection: result=${result.success ? "ok" : "fail"} (${result.message})`);
      this.sendTo(
        obj.from,
        obj.command,
        result.success ? { result: result.message } : { error: result.message },
        obj.callback
      );
    } finally {
      this.testClients.delete(testClient);
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
  replyAddError(obj, message) {
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
  async handleAddDelivery(obj) {
    if (!this.client) {
      this.log.debug("addDelivery: adapter not initialized");
      this.replyAddError(obj, "Adapter not initialized");
      return;
    }
    const raw = obj.message;
    const msg = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    if (typeof msg.tracking_number !== "string" || msg.tracking_number.length === 0 || typeof msg.carrier_code !== "string" || msg.carrier_code.length === 0 || typeof msg.description !== "string" || msg.description.length === 0) {
      this.log.debug("addDelivery: missing tracking_number/carrier_code/description in message");
      this.replyAddError(obj, "tracking_number, carrier_code and description are required");
      return;
    }
    if (msg.tracking_number.length > MAX_ADD_FIELD_LEN || msg.carrier_code.length > MAX_ADD_FIELD_LEN || msg.description.length > MAX_ADD_FIELD_LEN || typeof msg.language === "string" && msg.language.length > MAX_ADD_FIELD_LEN) {
      this.log.debug("addDelivery: a field exceeds the maximum length");
      this.replyAddError(obj, `each field must be at most ${MAX_ADD_FIELD_LEN} characters`);
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
    const nowMs = Date.now();
    this.addTimestamps = this.addTimestamps.filter((t) => nowMs - t < ADD_WINDOW_MS);
    if (this.addTimestamps.length >= MAX_ADDS_PER_WINDOW) {
      this.log.warn(`addDelivery throttled: more than ${MAX_ADDS_PER_WINDOW} requests within ${ADD_WINDOW_MS / 1e3}s`);
      this.replyAddError(obj, `too many addDelivery requests; max ${MAX_ADDS_PER_WINDOW} per ${ADD_WINDOW_MS / 1e3}s`);
      return;
    }
    this.addTimestamps.push(nowMs);
    const addResult = await this.client.addDelivery(request);
    const added = (0, import_coerce.isTrueish)(addResult.success);
    this.log.debug(`addDelivery: '${(0, import_coerce.oneLine)(request.tracking_number)}' result=${added ? "ok" : "fail"}`);
    this.sendTo(obj.from, obj.command, addResult, obj.callback);
    if (added) {
      void this.poll().catch((err) => this.log.error(`Poll after addDelivery failed: ${(0, import_coerce.errText)(err)}`));
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
   * v0.10.0 (M1): the client codes every failure it raises (TIMEOUT,
   * PARSE_ERROR, ABORTED, RATE_LIMITED, …) — a present machine code always
   * wins. The message-substring sniff only remains for code-less foreign
   * errors, so an API error_message merely CONTAINING "timeout" can no longer
   * be misclassified.
   *
   * @param error The error to classify
   */
  classifyError(error) {
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
  async poll() {
    if (this.isPolling || !this.client || !this.stateManager) {
      this.log.debug("Skipping poll \u2014 already running or not initialized");
      return;
    }
    const client = this.client;
    const stateManager = this.stateManager;
    const now = Date.now();
    const autoRemoveMode = this.config.autoRemoveDelivered !== false;
    this.log.debug(`poll: starting (autoRemove=${autoRemoveMode}, lastErrorCode='${this.lastErrorCode}')`);
    if (now < this.rateLimitedUntil) {
      const waitMin = Math.ceil((this.rateLimitedUntil - now) / 6e4);
      this.log.debug(`Skipping poll \u2014 rate limited for ${waitMin} more minute(s)`);
      return;
    }
    if (now - this.lastPollTime < MIN_POLL_GAP_MS) {
      this.log.debug("Skipping poll \u2014 too soon after last poll");
      return;
    }
    this.isPolling = true;
    this.lastPollTime = now;
    try {
      const deliveries = await client.getDeliveries(autoRemoveMode ? "active" : "recent");
      this.rateLimitedUntil = 0;
      if (this.lastErrorCode) {
        this.log.info("Connection restored");
        this.lastErrorCode = "";
      }
      await this.setStateChangedAsync("info.connection", { val: true, ack: true });
      const activeDeliveries = deliveries.filter((d) => stateManager.parseStatus(d) !== import_types.DELIVERED_STATUS_CODE);
      const visibleDeliveries = autoRemoveMode ? activeDeliveries : deliveries;
      stateManager.resetPollState();
      const pkgIds = visibleDeliveries.map((d) => stateManager.packageId(d));
      if (visibleDeliveries.length > UPDATE_BATCH_SIZE) {
        this.log.debug(`Updating ${visibleDeliveries.length} deliveries in batches of ${UPDATE_BATCH_SIZE}`);
      }
      for (let start = 0; start < visibleDeliveries.length; start += UPDATE_BATCH_SIZE) {
        const batch = visibleDeliveries.slice(start, start + UPDATE_BATCH_SIZE);
        await Promise.all(
          batch.map(async (delivery, offset) => {
            var _a, _b;
            const pkgId = pkgIds[start + offset];
            const tracking = (0, import_coerce.oneLine)((_a = delivery.tracking_number) != null ? _a : "");
            const carrier = (0, import_coerce.oneLine)((_b = delivery.carrier_code) != null ? _b : "");
            try {
              this.log.debug(
                `updateDelivery: '${tracking}' carrier=${carrier} status=${(0, import_coerce.oneLine)(String(delivery.status_code))}`
              );
              const carrierName = await client.getCarrierName(delivery.carrier_code);
              await stateManager.updateDelivery(delivery, carrierName, pkgId);
              this.failedDeliveries.delete(pkgId);
            } catch (err) {
              const msg = (0, import_coerce.errText)(err);
              if (this.failedDeliveries.has(pkgId)) {
                this.log.debug(`Failed to update '${tracking}': ${msg}`);
              } else if (this.unloaded) {
                this.log.debug(`Failed to update '${tracking}' during shutdown: ${msg}`);
              } else {
                this.log.warn(`Failed to update '${tracking}': ${msg}`);
                this.failedDeliveries.add(pkgId);
              }
            }
          })
        );
      }
      try {
        await stateManager.cleanupDeliveries(pkgIds);
        await stateManager.updateSummary(activeDeliveries);
      } catch (err) {
        this.log.warn(`State maintenance failed (API connection is fine, retrying next poll): ${(0, import_coerce.errText)(err)}`);
      }
      const seenPkgIds = new Set(pkgIds);
      for (const id of [...this.failedDeliveries]) {
        if (!seenPkgIds.has(id)) {
          this.failedDeliveries.delete(id);
        }
      }
      this.log.debug(`Polled ${visibleDeliveries.length} deliveries (${activeDeliveries.length} active)`);
    } catch (err) {
      await this.handlePollError(err);
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
  async handlePollError(error) {
    var _a;
    const errorCode = this.classifyError(error);
    const isRepeat = errorCode === this.lastErrorCode;
    this.lastErrorCode = errorCode;
    switch (errorCode) {
      case "ABORTED":
        this.log.debug(`Poll aborted: ${error.message}`);
        break;
      case "RATE_LIMITED": {
        const rawCooldown = (_a = error.retryAfterSeconds) != null ? _a : 0;
        const cooldownSec = Number.isFinite(rawCooldown) && rawCooldown > 0 ? Math.min(import_parcel_client.RETRY_AFTER_MAX_SEC, Math.max(60, Math.floor(rawCooldown))) : import_parcel_client.RETRY_AFTER_DEFAULT_SEC;
        this.rateLimitedUntil = Date.now() + cooldownSec * 1e3;
        const line = `Rate limit hit \u2014 pausing API requests for ${Math.ceil(cooldownSec / 60)} minute(s)`;
        if (isRepeat) {
          this.log.debug(line);
        } else {
          this.log.warn(line);
        }
        break;
      }
      case "FORBIDDEN": {
        const line = "parcel.app returned 403 Forbidden \u2014 your account may not have an active Premium subscription, or the API key was revoked. Check your account on parcelapp.net.";
        if (isRepeat) {
          this.log.debug(line);
        } else {
          this.log.error(line);
        }
        break;
      }
      case "INVALID_API_KEY": {
        const line = "Invalid API key \u2014 please check your parcel.app API key";
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
          this.log.warn("Cannot reach parcel.app API \u2014 will keep retrying");
        }
        break;
      case "TIMEOUT":
        if (isRepeat) {
          this.log.debug(`Poll failed (ongoing): ${error.message}`);
        } else {
          this.log.warn("API request timeout \u2014 will retry next cycle");
        }
        break;
      default:
        if (isRepeat) {
          this.log.debug(`Poll failed (ongoing): ${error.message}`);
        } else {
          this.log.error(`Poll failed: ${error.message}`);
        }
    }
    await this.setStateChangedAsync("info.connection", { val: false, ack: true }).catch(() => {
    });
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
