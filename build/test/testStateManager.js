"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const chai_1 = require("chai");
const state_manager_1 = require("../src/lib/state-manager");
const types_1 = require("../src/lib/types");
function createMockAdapter(language = "de") {
    const objects = new Map();
    const states = new Map();
    const debugMessages = [];
    return {
        namespace: "parcelapp.0",
        config: { language, autoRemoveDelivered: true },
        objects,
        states,
        log: {
            debug: (msg) => {
                debugMessages.push(msg);
            },
        },
        extendObjectAsync: async (id, obj) => {
            const existing = objects.get(id) || { type: "", common: {}, native: {} };
            objects.set(id, {
                type: obj.type || existing.type,
                common: { ...existing.common, ...(obj.common || {}) },
                native: { ...existing.native, ...(obj.native || {}) },
            });
        },
        setObjectNotExistsAsync: async (id, obj) => {
            if (!objects.has(id)) {
                objects.set(id, obj);
            }
        },
        setStateAsync: async (id, state) => {
            states.set(id, state);
        },
        delObjectAsync: async (id, _opts) => {
            for (const key of objects.keys()) {
                if (key === id || key.startsWith(`${id}.`)) {
                    objects.delete(key);
                }
            }
            for (const key of states.keys()) {
                if (key === id || key.startsWith(`${id}.`)) {
                    states.delete(key);
                }
            }
        },
        getObjectViewAsync: async (_design, _search, params) => {
            const rows = [];
            const prefix = params.startkey.replace("parcelapp.0.", "");
            for (const [key, value] of objects.entries()) {
                if (value.type === "device" && key.startsWith(prefix)) {
                    rows.push({ id: `parcelapp.0.${key}`, value });
                }
            }
            return { rows };
        },
    };
}
function makeDelivery(overrides = {}) {
    return {
        carrier_code: "dhl",
        description: "Test Package",
        status_code: "2",
        tracking_number: "1234567890",
        ...overrides,
    };
}
describe("StateManager", () => {
    let adapter;
    let manager;
    beforeEach(() => {
        adapter = createMockAdapter("de");
        manager = new state_manager_1.StateManager(adapter);
    });
    describe("sanitize", () => {
        it("should lowercase and replace non-alphanumeric chars", () => {
            (0, chai_1.expect)(manager.sanitize("DHL-Express_2024")).to.equal("dhl_express_2024");
        });
        it("should strip leading and trailing underscores", () => {
            (0, chai_1.expect)(manager.sanitize("__hello__")).to.equal("hello");
        });
        it("should collapse multiple non-alphanumeric chars into one underscore", () => {
            (0, chai_1.expect)(manager.sanitize("a---b...c")).to.equal("a_b_c");
        });
        it("should truncate to 50 characters", () => {
            const long = "a".repeat(60);
            (0, chai_1.expect)(manager.sanitize(long)).to.have.lengthOf(50);
        });
        it("should return 'unknown' for empty result", () => {
            (0, chai_1.expect)(manager.sanitize("___")).to.equal("unknown");
            (0, chai_1.expect)(manager.sanitize("")).to.equal("unknown");
        });
        it("should handle special characters", () => {
            (0, chai_1.expect)(manager.sanitize("PKG#2024/01@DE")).to.equal("pkg_2024_01_de");
        });
        it("should handle unicode characters", () => {
            (0, chai_1.expect)(manager.sanitize("Paket-Munch")).to.equal("paket_munch");
        });
    });
    describe("packageId", () => {
        it("should use sanitized tracking number", () => {
            const delivery = makeDelivery({ tracking_number: "DHL-123456" });
            (0, chai_1.expect)(manager.packageId(delivery)).to.equal("dhl_123456");
        });
        it("should append extra_information if present", () => {
            const delivery = makeDelivery({
                tracking_number: "ABC123",
                extra_information: "12345",
            });
            (0, chai_1.expect)(manager.packageId(delivery)).to.equal("abc123_12345");
        });
        it("should not append extra info if empty", () => {
            const delivery = makeDelivery({
                tracking_number: "ABC123",
                extra_information: "",
            });
            (0, chai_1.expect)(manager.packageId(delivery)).to.equal("abc123");
        });
        it("should not append extra info if undefined", () => {
            const delivery = makeDelivery({ tracking_number: "ABC123" });
            delete delivery.extra_information;
            (0, chai_1.expect)(manager.packageId(delivery)).to.equal("abc123");
        });
    });
    describe("updateDelivery", () => {
        it("should create device object with description as name", async () => {
            const delivery = makeDelivery({ description: "My DHL Package" });
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const device = adapter.objects.get(`deliveries.${pkgId}`);
            (0, chai_1.expect)(device).to.not.be.undefined;
            (0, chai_1.expect)(device.type).to.equal("device");
            (0, chai_1.expect)(device.common.name).to.equal("My DHL Package");
        });
        it("should use tracking number as fallback name when description is empty", async () => {
            const delivery = makeDelivery({ description: "", tracking_number: "TRK99" });
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const device = adapter.objects.get(`deliveries.${pkgId}`);
            (0, chai_1.expect)(device.common.name).to.equal("Package TRK99");
        });
        it("should create carrier state with correct value", async () => {
            const delivery = makeDelivery();
            await manager.updateDelivery(delivery, "DHL Express");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.carrier`);
            (0, chai_1.expect)(state?.val).to.equal("DHL Express");
            (0, chai_1.expect)(state?.ack).to.be.true;
        });
        it("should set status label in German when language is de", async () => {
            const delivery = makeDelivery({ status_code: "2" });
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.status`);
            (0, chai_1.expect)(state?.val).to.equal("Unterwegs");
        });
        it("should set status label in English when language is en", async () => {
            adapter = createMockAdapter("en");
            manager = new state_manager_1.StateManager(adapter);
            const delivery = makeDelivery({ status_code: "4" });
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.status`);
            (0, chai_1.expect)(state?.val).to.equal("Out for Delivery");
        });
        it("should set statusCode as number", async () => {
            const delivery = makeDelivery({ status_code: "8" });
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.statusCode`);
            (0, chai_1.expect)(state?.val).to.equal(8);
        });
        it("should handle unknown status code", async () => {
            const delivery = makeDelivery({ status_code: "99" });
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.status`);
            (0, chai_1.expect)(state?.val).to.equal("Unknown (99)");
        });
        it("should handle non-numeric status code", async () => {
            const delivery = makeDelivery({ status_code: "abc" });
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const statusCode = adapter.states.get(`deliveries.${pkgId}.statusCode`);
            (0, chai_1.expect)(statusCode?.val).to.equal(0);
            const status = adapter.states.get(`deliveries.${pkgId}.status`);
            (0, chai_1.expect)(status?.val).to.equal("Zugestellt"); // status code 0 = Delivered
        });
        it("should set trackingNumber as original string", async () => {
            const delivery = makeDelivery({ tracking_number: "DHL-ABC-123" });
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.trackingNumber`);
            (0, chai_1.expect)(state?.val).to.equal("DHL-ABC-123");
        });
        it("should set extraInfo or empty string", async () => {
            const delivery = makeDelivery({ extra_information: "PLZ12345" });
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.extraInfo`);
            (0, chai_1.expect)(state?.val).to.equal("PLZ12345");
        });
        it("should set empty extraInfo when undefined", async () => {
            const delivery = makeDelivery();
            delete delivery.extra_information;
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.extraInfo`);
            (0, chai_1.expect)(state?.val).to.equal("");
        });
        it("should set lastUpdated as ISO string", async () => {
            const delivery = makeDelivery();
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.lastUpdated`);
            (0, chai_1.expect)(state?.val).to.be.a("string");
            // Verify it's a valid ISO date
            const date = new Date(state?.val);
            (0, chai_1.expect)(date.getTime()).to.not.be.NaN;
        });
        it("should create all expected states", async () => {
            const delivery = makeDelivery();
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const expectedStates = [
                "carrier",
                "status",
                "statusCode",
                "description",
                "trackingNumber",
                "extraInfo",
                "deliveryWindow",
                "deliveryEstimate",
                "lastEvent",
                "lastLocation",
                "lastUpdated",
            ];
            for (const state of expectedStates) {
                (0, chai_1.expect)(adapter.states.has(`deliveries.${pkgId}.${state}`), `Missing state: ${state}`).to.be.true;
            }
        });
        it("should create state objects with correct types", async () => {
            const delivery = makeDelivery();
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const carrierObj = adapter.objects.get(`deliveries.${pkgId}.carrier`);
            (0, chai_1.expect)(carrierObj?.common.type).to.equal("string");
            (0, chai_1.expect)(carrierObj?.common.role).to.equal("text");
            (0, chai_1.expect)(carrierObj?.common.read).to.be.true;
            (0, chai_1.expect)(carrierObj?.common.write).to.be.false;
            const codeObj = adapter.objects.get(`deliveries.${pkgId}.statusCode`);
            (0, chai_1.expect)(codeObj?.common.type).to.equal("number");
            (0, chai_1.expect)(codeObj?.common.role).to.equal("value");
        });
    });
    describe("status labels", () => {
        it("should have all status codes 0-8 in German", () => {
            for (let i = 0; i <= 8; i++) {
                (0, chai_1.expect)(types_1.STATUS_LABELS_DE[i], `Missing DE label for code ${i}`).to.be.a("string");
                (0, chai_1.expect)(types_1.STATUS_LABELS_DE[i].length).to.be.greaterThan(0);
            }
        });
        it("should have all status codes 0-8 in English", () => {
            for (let i = 0; i <= 8; i++) {
                (0, chai_1.expect)(types_1.STATUS_LABELS_EN[i], `Missing EN label for code ${i}`).to.be.a("string");
                (0, chai_1.expect)(types_1.STATUS_LABELS_EN[i].length).to.be.greaterThan(0);
            }
        });
        it("should have matching key sets for DE and EN", () => {
            const deKeys = Object.keys(types_1.STATUS_LABELS_DE).sort();
            const enKeys = Object.keys(types_1.STATUS_LABELS_EN).sort();
            (0, chai_1.expect)(deKeys).to.deep.equal(enKeys);
        });
        it("should map all codes through updateDelivery in DE", async () => {
            for (let code = 0; code <= 8; code++) {
                adapter = createMockAdapter("de");
                manager = new state_manager_1.StateManager(adapter);
                const delivery = makeDelivery({ status_code: String(code), tracking_number: `trk${code}` });
                await manager.updateDelivery(delivery, "Test");
                const pkgId = manager.packageId(delivery);
                const status = adapter.states.get(`deliveries.${pkgId}.status`);
                (0, chai_1.expect)(status?.val, `Status for code ${code}`).to.equal(types_1.STATUS_LABELS_DE[code]);
            }
        });
        it("should map all codes through updateDelivery in EN", async () => {
            for (let code = 0; code <= 8; code++) {
                adapter = createMockAdapter("en");
                manager = new state_manager_1.StateManager(adapter);
                const delivery = makeDelivery({ status_code: String(code), tracking_number: `trk${code}` });
                await manager.updateDelivery(delivery, "Test");
                const pkgId = manager.packageId(delivery);
                const status = adapter.states.get(`deliveries.${pkgId}.status`);
                (0, chai_1.expect)(status?.val, `Status for code ${code}`).to.equal(types_1.STATUS_LABELS_EN[code]);
            }
        });
    });
    describe("delivery window calculation", () => {
        it("should return empty string for non-trackable status (delivered)", async () => {
            const delivery = makeDelivery({
                status_code: "0",
                timestamp_expected: Math.floor(Date.now() / 1000) + 3600,
            });
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.deliveryWindow`);
            (0, chai_1.expect)(state?.val).to.equal("");
        });
        it("should return empty string for non-trackable status (frozen)", async () => {
            const delivery = makeDelivery({
                status_code: "1",
                timestamp_expected: Math.floor(Date.now() / 1000) + 3600,
            });
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.deliveryWindow`);
            (0, chai_1.expect)(state?.val).to.equal("");
        });
        it("should return time window for in-transit status", async () => {
            // Use a fixed timestamp to get predictable time output
            const start = new Date();
            start.setHours(14, 0, 0, 0);
            const end = new Date();
            end.setHours(16, 0, 0, 0);
            const delivery = makeDelivery({
                status_code: "2",
                timestamp_expected: Math.floor(start.getTime() / 1000),
                timestamp_expected_end: Math.floor(end.getTime() / 1000),
            });
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.deliveryWindow`);
            (0, chai_1.expect)(state?.val).to.equal("14:00 - 16:00");
        });
        it("should return single time when no end timestamp", async () => {
            const start = new Date();
            start.setHours(10, 30, 0, 0);
            const delivery = makeDelivery({
                status_code: "4",
                timestamp_expected: Math.floor(start.getTime() / 1000),
            });
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.deliveryWindow`);
            (0, chai_1.expect)(state?.val).to.equal("10:30");
        });
        it("should return empty string when no timestamps", async () => {
            const delivery = makeDelivery({ status_code: "2" });
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.deliveryWindow`);
            (0, chai_1.expect)(state?.val).to.equal("");
        });
        it("should work for status code 8 (Info Received)", async () => {
            const start = new Date();
            start.setHours(9, 0, 0, 0);
            const delivery = makeDelivery({
                status_code: "8",
                timestamp_expected: Math.floor(start.getTime() / 1000),
            });
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.deliveryWindow`);
            (0, chai_1.expect)(state?.val).to.equal("09:00");
        });
    });
    describe("delivery estimate calculation", () => {
        it("should return empty string for non-trackable status", async () => {
            const delivery = makeDelivery({
                status_code: "0",
                timestamp_expected: Math.floor(Date.now() / 1000),
            });
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.deliveryEstimate`);
            (0, chai_1.expect)(state?.val).to.equal("");
        });
        it("should return 'heute' for today delivery in German", async () => {
            const today = new Date();
            today.setHours(15, 0, 0, 0);
            const delivery = makeDelivery({
                status_code: "2",
                timestamp_expected: Math.floor(today.getTime() / 1000),
            });
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.deliveryEstimate`);
            (0, chai_1.expect)(state?.val).to.equal("heute");
        });
        it("should return 'today' for today delivery in English", async () => {
            adapter = createMockAdapter("en");
            manager = new state_manager_1.StateManager(adapter);
            const today = new Date();
            today.setHours(15, 0, 0, 0);
            const delivery = makeDelivery({
                status_code: "2",
                timestamp_expected: Math.floor(today.getTime() / 1000),
            });
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.deliveryEstimate`);
            (0, chai_1.expect)(state?.val).to.equal("today");
        });
        it("should return 'morgen' for tomorrow delivery in German", async () => {
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            tomorrow.setHours(12, 0, 0, 0);
            const delivery = makeDelivery({
                status_code: "4",
                timestamp_expected: Math.floor(tomorrow.getTime() / 1000),
            });
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.deliveryEstimate`);
            (0, chai_1.expect)(state?.val).to.equal("morgen");
        });
        it("should return 'tomorrow' for tomorrow delivery in English", async () => {
            adapter = createMockAdapter("en");
            manager = new state_manager_1.StateManager(adapter);
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            tomorrow.setHours(12, 0, 0, 0);
            const delivery = makeDelivery({
                status_code: "4",
                timestamp_expected: Math.floor(tomorrow.getTime() / 1000),
            });
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.deliveryEstimate`);
            (0, chai_1.expect)(state?.val).to.equal("tomorrow");
        });
        it("should return 'in X Tagen' for future delivery in German", async () => {
            const future = new Date();
            future.setDate(future.getDate() + 3);
            future.setHours(12, 0, 0, 0);
            const delivery = makeDelivery({
                status_code: "2",
                timestamp_expected: Math.floor(future.getTime() / 1000),
            });
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.deliveryEstimate`);
            (0, chai_1.expect)(state?.val).to.equal("in 3 Tagen");
        });
        it("should return 'in %d days' for future delivery in English", async () => {
            adapter = createMockAdapter("en");
            manager = new state_manager_1.StateManager(adapter);
            const future = new Date();
            future.setDate(future.getDate() + 5);
            future.setHours(12, 0, 0, 0);
            const delivery = makeDelivery({
                status_code: "2",
                timestamp_expected: Math.floor(future.getTime() / 1000),
            });
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.deliveryEstimate`);
            (0, chai_1.expect)(state?.val).to.equal("in 5 days");
        });
        it("should return 'ueberfaellig' for overdue delivery in German", async () => {
            const past = new Date();
            past.setDate(past.getDate() - 2);
            past.setHours(12, 0, 0, 0);
            const delivery = makeDelivery({
                status_code: "2",
                timestamp_expected: Math.floor(past.getTime() / 1000),
            });
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.deliveryEstimate`);
            // German: "ueberfaellig" is stored as Unicode
            (0, chai_1.expect)(state?.val).to.equal("\u00fcberfällig");
        });
        it("should return 'overdue' for overdue delivery in English", async () => {
            adapter = createMockAdapter("en");
            manager = new state_manager_1.StateManager(adapter);
            const past = new Date();
            past.setDate(past.getDate() - 2);
            past.setHours(12, 0, 0, 0);
            const delivery = makeDelivery({
                status_code: "2",
                timestamp_expected: Math.floor(past.getTime() / 1000),
            });
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.deliveryEstimate`);
            (0, chai_1.expect)(state?.val).to.equal("overdue");
        });
        it("should use date_expected as fallback when no timestamp", async () => {
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            const dateStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
            const delivery = makeDelivery({
                status_code: "2",
                date_expected: dateStr,
            });
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.deliveryEstimate`);
            (0, chai_1.expect)(state?.val).to.equal("morgen");
        });
        it("should return empty string when no expected date at all", async () => {
            const delivery = makeDelivery({ status_code: "2" });
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.deliveryEstimate`);
            (0, chai_1.expect)(state?.val).to.equal("");
        });
        it("should return empty string for invalid date", async () => {
            const delivery = makeDelivery({
                status_code: "2",
                date_expected: "not-a-date",
            });
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.deliveryEstimate`);
            (0, chai_1.expect)(state?.val).to.equal("");
        });
    });
    describe("last event formatting", () => {
        it("should format event with date", async () => {
            const delivery = makeDelivery({
                events: [{ event: "Arrived at sort facility", date: "2026-04-04 10:30" }],
            });
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.lastEvent`);
            (0, chai_1.expect)(state?.val).to.equal("Arrived at sort facility - 2026-04-04 10:30");
        });
        it("should return only event when no date", async () => {
            const delivery = makeDelivery({
                events: [{ event: "Package picked up", date: "" }],
            });
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.lastEvent`);
            (0, chai_1.expect)(state?.val).to.equal("Package picked up");
        });
        it("should return empty string when no events", async () => {
            const delivery = makeDelivery({ events: [] });
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.lastEvent`);
            (0, chai_1.expect)(state?.val).to.equal("");
        });
        it("should return empty string when events is undefined", async () => {
            const delivery = makeDelivery();
            delete delivery.events;
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.lastEvent`);
            (0, chai_1.expect)(state?.val).to.equal("");
        });
        it("should use the first event (newest)", async () => {
            const delivery = makeDelivery({
                events: [
                    { event: "Delivered", date: "2026-04-04" },
                    { event: "In transit", date: "2026-04-03" },
                    { event: "Picked up", date: "2026-04-02" },
                ],
            });
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.lastEvent`);
            (0, chai_1.expect)(state?.val).to.equal("Delivered - 2026-04-04");
        });
    });
    describe("last location extraction", () => {
        it("should extract location from first event", async () => {
            const delivery = makeDelivery({
                events: [{ event: "Arrived", date: "2026-04-04", location: "Berlin Hub" }],
            });
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.lastLocation`);
            (0, chai_1.expect)(state?.val).to.equal("Berlin Hub");
        });
        it("should return empty string when location is undefined", async () => {
            const delivery = makeDelivery({
                events: [{ event: "Arrived", date: "2026-04-04" }],
            });
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.lastLocation`);
            (0, chai_1.expect)(state?.val).to.equal("");
        });
        it("should return empty string when no events", async () => {
            const delivery = makeDelivery();
            delete delivery.events;
            await manager.updateDelivery(delivery, "DHL");
            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.lastLocation`);
            (0, chai_1.expect)(state?.val).to.equal("");
        });
    });
    describe("updateSummary", () => {
        it("should create summary channel", async () => {
            await manager.updateSummary([]);
            const channel = adapter.objects.get("summary");
            (0, chai_1.expect)(channel).to.not.be.undefined;
            (0, chai_1.expect)(channel.type).to.equal("channel");
        });
        it("should set activeCount to 0 for empty deliveries", async () => {
            await manager.updateSummary([]);
            const state = adapter.states.get("summary.activeCount");
            (0, chai_1.expect)(state?.val).to.equal(0);
            (0, chai_1.expect)(state?.ack).to.be.true;
        });
        it("should count active deliveries", async () => {
            const deliveries = [
                makeDelivery({ status_code: "2", tracking_number: "A" }),
                makeDelivery({ status_code: "4", tracking_number: "B" }),
                makeDelivery({ status_code: "8", tracking_number: "C" }),
            ];
            await manager.updateSummary(deliveries);
            const state = adapter.states.get("summary.activeCount");
            (0, chai_1.expect)(state?.val).to.equal(3);
        });
        it("should count today deliveries", async () => {
            const today = new Date();
            today.setHours(15, 0, 0, 0);
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            const deliveries = [
                makeDelivery({
                    status_code: "2",
                    tracking_number: "A",
                    timestamp_expected: Math.floor(today.getTime() / 1000),
                }),
                makeDelivery({
                    status_code: "4",
                    tracking_number: "B",
                    timestamp_expected: Math.floor(tomorrow.getTime() / 1000),
                }),
            ];
            await manager.updateSummary(deliveries);
            const state = adapter.states.get("summary.todayCount");
            (0, chai_1.expect)(state?.val).to.equal(1);
        });
        it("should set todayCount to 0 when no deliveries today", async () => {
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 3);
            const deliveries = [
                makeDelivery({
                    status_code: "2",
                    tracking_number: "A",
                    timestamp_expected: Math.floor(tomorrow.getTime() / 1000),
                }),
            ];
            await manager.updateSummary(deliveries);
            const state = adapter.states.get("summary.todayCount");
            (0, chai_1.expect)(state?.val).to.equal(0);
        });
        it("should calculate combined delivery window", async () => {
            const today = new Date();
            const start1 = new Date(today);
            start1.setHours(10, 0, 0, 0);
            const end1 = new Date(today);
            end1.setHours(12, 0, 0, 0);
            const start2 = new Date(today);
            start2.setHours(14, 0, 0, 0);
            const end2 = new Date(today);
            end2.setHours(16, 0, 0, 0);
            const deliveries = [
                makeDelivery({
                    status_code: "2",
                    tracking_number: "A",
                    timestamp_expected: Math.floor(start1.getTime() / 1000),
                    timestamp_expected_end: Math.floor(end1.getTime() / 1000),
                }),
                makeDelivery({
                    status_code: "4",
                    tracking_number: "B",
                    timestamp_expected: Math.floor(start2.getTime() / 1000),
                    timestamp_expected_end: Math.floor(end2.getTime() / 1000),
                }),
            ];
            await manager.updateSummary(deliveries);
            const state = adapter.states.get("summary.deliveryWindow");
            (0, chai_1.expect)(state?.val).to.equal("10:00 - 16:00");
        });
        it("should return empty delivery window when no today deliveries", async () => {
            await manager.updateSummary([]);
            const state = adapter.states.get("summary.deliveryWindow");
            (0, chai_1.expect)(state?.val).to.equal("");
        });
    });
    describe("API-drift guards", () => {
        describe("sanitize", () => {
            it("should return 'unknown' for null", () => {
                (0, chai_1.expect)(manager.sanitize(null)).to.equal("unknown");
            });
            it("should return 'unknown' for undefined", () => {
                (0, chai_1.expect)(manager.sanitize(undefined)).to.equal("unknown");
            });
            it("should return 'unknown' for number", () => {
                (0, chai_1.expect)(manager.sanitize(42)).to.equal("unknown");
            });
            it("should return 'unknown' for object", () => {
                (0, chai_1.expect)(manager.sanitize({})).to.equal("unknown");
            });
            it("should return 'unknown' for array", () => {
                (0, chai_1.expect)(manager.sanitize([])).to.equal("unknown");
            });
        });
        describe("parseStatus", () => {
            it("should accept number status_code (API drift)", () => {
                const delivery = makeDelivery({
                    status_code: 2,
                });
                (0, chai_1.expect)(manager.parseStatus(delivery)).to.equal(2);
            });
            it("should truncate fractional numbers", () => {
                const delivery = makeDelivery({
                    status_code: 2.7,
                });
                (0, chai_1.expect)(manager.parseStatus(delivery)).to.equal(2);
            });
            it("should return 0 for NaN number", () => {
                const delivery = makeDelivery({
                    status_code: NaN,
                });
                (0, chai_1.expect)(manager.parseStatus(delivery)).to.equal(0);
            });
            it("should return 0 for Infinity", () => {
                const delivery = makeDelivery({
                    status_code: Infinity,
                });
                (0, chai_1.expect)(manager.parseStatus(delivery)).to.equal(0);
            });
            it("should return 0 for null", () => {
                const delivery = makeDelivery({
                    status_code: null,
                });
                (0, chai_1.expect)(manager.parseStatus(delivery)).to.equal(0);
            });
            it("should return 0 for object", () => {
                const delivery = makeDelivery({
                    status_code: {},
                });
                (0, chai_1.expect)(manager.parseStatus(delivery)).to.equal(0);
            });
            it("should return 0 for non-numeric string", () => {
                const delivery = makeDelivery({ status_code: "abc" });
                (0, chai_1.expect)(manager.parseStatus(delivery)).to.equal(0);
            });
        });
        describe("packageId", () => {
            it("should ignore non-string extra_information (number)", () => {
                const delivery = makeDelivery({
                    tracking_number: "ABC",
                    extra_information: 12345,
                });
                (0, chai_1.expect)(manager.packageId(delivery)).to.equal("abc");
            });
            it("should ignore non-string extra_information (object)", () => {
                const delivery = makeDelivery({
                    tracking_number: "ABC",
                    extra_information: { foo: "bar" },
                });
                (0, chai_1.expect)(manager.packageId(delivery)).to.equal("abc");
            });
            it("should handle non-string tracking_number", () => {
                const delivery = makeDelivery({
                    tracking_number: null,
                });
                (0, chai_1.expect)(manager.packageId(delivery)).to.equal("unknown");
            });
        });
        describe("updateDelivery with malformed fields", () => {
            it("should handle non-string description (number)", async () => {
                const delivery = makeDelivery({
                    description: 42,
                    tracking_number: "TRK1",
                });
                await manager.updateDelivery(delivery, "DHL");
                const pkgId = manager.packageId(delivery);
                const state = adapter.states.get(`deliveries.${pkgId}.description`);
                (0, chai_1.expect)(state?.val).to.equal("");
                const device = adapter.objects.get(`deliveries.${pkgId}`);
                (0, chai_1.expect)(device.common.name).to.equal("Package TRK1");
            });
            it("should handle non-string tracking_number", async () => {
                const delivery = makeDelivery({
                    tracking_number: 999,
                    description: "",
                });
                await manager.updateDelivery(delivery, "DHL");
                const pkgId = manager.packageId(delivery);
                const state = adapter.states.get(`deliveries.${pkgId}.trackingNumber`);
                (0, chai_1.expect)(state?.val).to.equal("");
            });
            it("should handle non-string extra_information", async () => {
                const delivery = makeDelivery({
                    extra_information: { zip: "12345" },
                });
                await manager.updateDelivery(delivery, "DHL");
                const pkgId = manager.packageId(delivery);
                const state = adapter.states.get(`deliveries.${pkgId}.extraInfo`);
                (0, chai_1.expect)(state?.val).to.equal("");
            });
            it("should handle events as non-array (object)", async () => {
                const delivery = makeDelivery({
                    events: { event: "x", date: "y" },
                });
                await manager.updateDelivery(delivery, "DHL");
                const pkgId = manager.packageId(delivery);
                (0, chai_1.expect)(adapter.states.get(`deliveries.${pkgId}.lastEvent`)?.val).to.equal("");
                (0, chai_1.expect)(adapter.states.get(`deliveries.${pkgId}.lastLocation`)?.val).to.equal("");
            });
            it("should handle events with null first entry", async () => {
                const delivery = makeDelivery({
                    events: [null],
                });
                await manager.updateDelivery(delivery, "DHL");
                const pkgId = manager.packageId(delivery);
                (0, chai_1.expect)(adapter.states.get(`deliveries.${pkgId}.lastEvent`)?.val).to.equal("");
                (0, chai_1.expect)(adapter.states.get(`deliveries.${pkgId}.lastLocation`)?.val).to.equal("");
            });
            it("should handle event with non-string fields", async () => {
                const delivery = makeDelivery({
                    events: [
                        {
                            event: 123,
                            date: null,
                            location: 42,
                        },
                    ],
                });
                await manager.updateDelivery(delivery, "DHL");
                const pkgId = manager.packageId(delivery);
                (0, chai_1.expect)(adapter.states.get(`deliveries.${pkgId}.lastEvent`)?.val).to.equal("");
                (0, chai_1.expect)(adapter.states.get(`deliveries.${pkgId}.lastLocation`)?.val).to.equal("");
            });
            it("should handle timestamp_expected as numeric string (API drift)", async () => {
                const now = new Date();
                now.setHours(11, 15, 0, 0);
                const ts = Math.floor(now.getTime() / 1000);
                const delivery = makeDelivery({
                    status_code: "2",
                    timestamp_expected: String(ts),
                });
                await manager.updateDelivery(delivery, "DHL");
                const pkgId = manager.packageId(delivery);
                const window = adapter.states.get(`deliveries.${pkgId}.deliveryWindow`);
                (0, chai_1.expect)(window?.val).to.equal("11:15");
            });
            it("should handle timestamp_expected as non-finite value", async () => {
                const delivery = makeDelivery({
                    status_code: "2",
                    timestamp_expected: NaN,
                });
                await manager.updateDelivery(delivery, "DHL");
                const pkgId = manager.packageId(delivery);
                const window = adapter.states.get(`deliveries.${pkgId}.deliveryWindow`);
                (0, chai_1.expect)(window?.val).to.equal("");
            });
            it("should handle date_expected as non-string (null)", async () => {
                const delivery = makeDelivery({
                    status_code: "2",
                    date_expected: null,
                });
                await manager.updateDelivery(delivery, "DHL");
                const pkgId = manager.packageId(delivery);
                const estimate = adapter.states.get(`deliveries.${pkgId}.deliveryEstimate`);
                (0, chai_1.expect)(estimate?.val).to.equal("");
            });
            it("should handle timestamp_expected_end as garbage", async () => {
                const start = new Date();
                start.setHours(9, 0, 0, 0);
                const delivery = makeDelivery({
                    status_code: "2",
                    timestamp_expected: Math.floor(start.getTime() / 1000),
                    timestamp_expected_end: "not-a-number",
                });
                await manager.updateDelivery(delivery, "DHL");
                const pkgId = manager.packageId(delivery);
                const window = adapter.states.get(`deliveries.${pkgId}.deliveryWindow`);
                (0, chai_1.expect)(window?.val).to.equal("09:00");
            });
            it("should handle numeric status_code (API drift)", async () => {
                const delivery = makeDelivery({
                    status_code: 4,
                });
                await manager.updateDelivery(delivery, "DHL");
                const pkgId = manager.packageId(delivery);
                (0, chai_1.expect)(adapter.states.get(`deliveries.${pkgId}.statusCode`)?.val).to.equal(4);
                (0, chai_1.expect)(adapter.states.get(`deliveries.${pkgId}.status`)?.val).to.equal("In Zustellung");
            });
        });
    });
    describe("cleanupDeliveries", () => {
        it("should remove stale deliveries", async () => {
            // Create two deliveries
            const d1 = makeDelivery({ tracking_number: "KEEP", status_code: "2" });
            const d2 = makeDelivery({ tracking_number: "REMOVE", status_code: "2" });
            await manager.updateDelivery(d1, "DHL");
            await manager.updateDelivery(d2, "DHL");
            const keepId = manager.packageId(d1);
            const removeId = manager.packageId(d2);
            // Only keep the first one
            await manager.cleanupDeliveries([keepId]);
            // The kept delivery should still exist
            (0, chai_1.expect)(adapter.objects.has(`deliveries.${keepId}`)).to.be.true;
            (0, chai_1.expect)(adapter.states.has(`deliveries.${keepId}.carrier`)).to.be.true;
            // The removed delivery should be gone
            (0, chai_1.expect)(adapter.objects.has(`deliveries.${removeId}`)).to.be.false;
        });
        it("should not remove anything when all IDs are active", async () => {
            const d1 = makeDelivery({ tracking_number: "A", status_code: "2" });
            const d2 = makeDelivery({ tracking_number: "B", status_code: "4" });
            await manager.updateDelivery(d1, "DHL");
            await manager.updateDelivery(d2, "UPS");
            const id1 = manager.packageId(d1);
            const id2 = manager.packageId(d2);
            const objectsBefore = adapter.objects.size;
            await manager.cleanupDeliveries([id1, id2]);
            (0, chai_1.expect)(adapter.objects.size).to.equal(objectsBefore);
        });
        it("should handle empty active IDs", async () => {
            const d1 = makeDelivery({ tracking_number: "OLD", status_code: "2" });
            await manager.updateDelivery(d1, "DHL");
            await manager.cleanupDeliveries([]);
            // Everything should be removed
            (0, chai_1.expect)(adapter.objects.has(`deliveries.${manager.packageId(d1)}`)).to.be.false;
        });
    });
});
