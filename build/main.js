"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const utils = __importStar(require("@iobroker/adapter-core"));
const parcel_client_1 = require("./lib/parcel-client");
const state_manager_1 = require("./lib/state-manager");
require("./lib/types");
const MIN_POLL_INTERVAL = 5;
const MAX_POLL_INTERVAL = 60;
const DEFAULT_POLL_INTERVAL = 10;
/** ioBroker adapter for parcel.app package tracking */
class ParcelappAdapter extends utils.Adapter {
    client = null;
    stateManager = null;
    pollTimer = null;
    isPolling = false;
    /** @param options Adapter options */
    constructor(options = {}) {
        super({
            ...options,
            name: "parcelapp",
        });
        this.on("ready", this.onReady.bind(this));
        this.on("unload", this.onUnload.bind(this));
        this.on("message", this.onMessage.bind(this));
    }
    async onReady() {
        await this.setStateAsync("info.connection", { val: false, ack: true });
        // Validate config
        const { apiKey } = this.config;
        if (!apiKey || apiKey.trim().length < 10) {
            this.log.error("No valid API key configured — please enter your parcel.app API key in the adapter settings");
            return;
        }
        // Initialize
        this.client = new parcel_client_1.ParcelClient(apiKey.trim());
        this.stateManager = new state_manager_1.StateManager(this);
        // Cleanup obsolete states
        await this.cleanupObsoleteStates();
        // Initial poll
        await this.poll();
        // Set up recurring poll
        const interval = Math.max(MIN_POLL_INTERVAL, Math.min(MAX_POLL_INTERVAL, this.config.pollInterval ?? DEFAULT_POLL_INTERVAL));
        const intervalMs = interval * 60 * 1000;
        this.pollTimer = setInterval(() => void this.poll(), intervalMs);
        this.log.info(`Parcel tracking started — polling every ${interval} minutes`);
    }
    onUnload(callback) {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        void this.setState("info.connection", { val: false, ack: true });
        callback();
    }
    async onMessage(obj) {
        if (!obj?.command) {
            return;
        }
        switch (obj.command) {
            case "checkConnection": {
                const msg = obj.message;
                const key = msg?.apiKey?.trim() || "";
                if (!key || key.length < 10) {
                    this.sendTo(obj.from, obj.command, {
                        success: false,
                        message: "API key is too short",
                    }, obj.callback);
                    return;
                }
                const testClient = new parcel_client_1.ParcelClient(key);
                const result = await testClient.testConnection();
                this.sendTo(obj.from, obj.command, result, obj.callback);
                break;
            }
            case "addDelivery": {
                if (!this.client) {
                    this.sendTo(obj.from, obj.command, {
                        success: false,
                        error_message: "Adapter not initialized",
                    }, obj.callback);
                    return;
                }
                const request = obj.message;
                const addResult = await this.client.addDelivery(request);
                this.sendTo(obj.from, obj.command, addResult, obj.callback);
                if (addResult.success) {
                    // Trigger immediate poll to pick up the new delivery
                    void this.poll();
                }
                break;
            }
            default:
                this.sendTo(obj.from, obj.command, { error: "Unknown command" }, obj.callback);
        }
    }
    async cleanupObsoleteStates() {
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
    async poll() {
        if (this.isPolling || !this.client || !this.stateManager) {
            return;
        }
        this.isPolling = true;
        try {
            // When keeping delivered packages, use "recent" to get them from API
            const autoRemove = this.config.autoRemoveDelivered !== false;
            const deliveries = await this.client.getDeliveries(autoRemove ? "active" : "recent");
            await this.setStateAsync("info.connection", { val: true, ack: true });
            // Filter deliveries based on auto-remove setting
            const visibleDeliveries = autoRemove
                ? deliveries.filter((d) => parseInt(d.status_code, 10) !== 0)
                : deliveries;
            // Update each delivery
            const activeIds = [];
            for (const delivery of visibleDeliveries) {
                const carrierName = await this.client.getCarrierName(delivery.carrier_code);
                await this.stateManager.updateDelivery(delivery, carrierName);
                activeIds.push(this.stateManager.packageId(delivery));
            }
            // Cleanup stale deliveries
            await this.stateManager.cleanupDeliveries(activeIds);
            // Update summary
            const summaryDeliveries = autoRemove
                ? visibleDeliveries
                : deliveries.filter((d) => parseInt(d.status_code, 10) !== 0);
            await this.stateManager.updateSummary(summaryDeliveries);
            this.log.debug(`Polled ${visibleDeliveries.length} deliveries (${summaryDeliveries.length} active)`);
        }
        catch (err) {
            const error = err;
            if (error.code === "INVALID_API_KEY") {
                this.log.error("Invalid API key — please check your parcel.app API key");
            }
            else if (error.message.includes("timeout")) {
                this.log.error(`API request timeout: ${error.message}`);
            }
            else {
                this.log.error(`Poll failed: ${error.message}`);
            }
            await this.setStateAsync("info.connection", { val: false, ack: true });
        }
        finally {
            this.isPolling = false;
        }
    }
}
if (require.main !== module) {
    module.exports = (options) => new ParcelappAdapter(options);
}
else {
    (() => new ParcelappAdapter())();
}
