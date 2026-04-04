import { expect } from "chai";
import { StateManager } from "../src/lib/state-manager";
import { STATUS_LABELS_DE, STATUS_LABELS_EN } from "../src/lib/types";
import type { ParcelDelivery } from "../src/lib/types";

interface ObjectDef {
    type: string;
    common: Record<string, unknown>;
    native: Record<string, unknown>;
}

interface StateValue {
    val: unknown;
    ack: boolean;
}

interface ObjectViewRow {
    id: string;
    value: unknown;
}

interface MockAdapter {
    namespace: string;
    config: { language: "de" | "en"; autoRemoveDelivered: boolean };
    objects: Map<string, ObjectDef>;
    states: Map<string, StateValue>;
    log: { debug: (msg: string) => void };
    extendObjectAsync: (id: string, obj: Partial<ObjectDef>) => Promise<void>;
    setStateAsync: (id: string, state: StateValue) => Promise<void>;
    delObjectAsync: (id: string, opts?: { recursive: boolean }) => Promise<void>;
    getObjectViewAsync: (
        design: string,
        search: string,
        params: { startkey: string; endkey: string },
    ) => Promise<{ rows: ObjectViewRow[] }>;
}

function createMockAdapter(language: "de" | "en" = "de"): MockAdapter {
    const objects = new Map<string, ObjectDef>();
    const states = new Map<string, StateValue>();
    const debugMessages: string[] = [];

    return {
        namespace: "parcelapp.0",
        config: { language, autoRemoveDelivered: true },
        objects,
        states,
        log: {
            debug: (msg: string): void => {
                debugMessages.push(msg);
            },
        },
        extendObjectAsync: async (id: string, obj: Partial<ObjectDef>): Promise<void> => {
            const existing = objects.get(id) || { type: "", common: {}, native: {} };
            objects.set(id, {
                type: obj.type || existing.type,
                common: { ...existing.common, ...(obj.common || {}) },
                native: { ...existing.native, ...(obj.native || {}) },
            });
        },
        setStateAsync: async (id: string, state: StateValue): Promise<void> => {
            states.set(id, state);
        },
        delObjectAsync: async (id: string, _opts?: { recursive: boolean }): Promise<void> => {
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
        getObjectViewAsync: async (
            _design: string,
            _search: string,
            params: { startkey: string; endkey: string },
        ): Promise<{ rows: ObjectViewRow[] }> => {
            const rows: ObjectViewRow[] = [];
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

function makeDelivery(overrides: Partial<ParcelDelivery> = {}): ParcelDelivery {
    return {
        carrier_code: "dhl",
        description: "Test Package",
        status_code: "2",
        tracking_number: "1234567890",
        ...overrides,
    };
}

describe("StateManager", () => {
    let adapter: MockAdapter;
    let manager: StateManager;

    beforeEach(() => {
        adapter = createMockAdapter("de");
        manager = new StateManager(adapter as never);
    });

    describe("sanitize", () => {
        it("should lowercase and replace non-alphanumeric chars", () => {
            expect(manager.sanitize("DHL-Express_2024")).to.equal("dhl_express_2024");
        });

        it("should strip leading and trailing underscores", () => {
            expect(manager.sanitize("__hello__")).to.equal("hello");
        });

        it("should collapse multiple non-alphanumeric chars into one underscore", () => {
            expect(manager.sanitize("a---b...c")).to.equal("a_b_c");
        });

        it("should truncate to 50 characters", () => {
            const long = "a".repeat(60);
            expect(manager.sanitize(long)).to.have.lengthOf(50);
        });

        it("should return 'unknown' for empty result", () => {
            expect(manager.sanitize("___")).to.equal("unknown");
            expect(manager.sanitize("")).to.equal("unknown");
        });

        it("should handle special characters", () => {
            expect(manager.sanitize("PKG#2024/01@DE")).to.equal("pkg_2024_01_de");
        });

        it("should handle unicode characters", () => {
            expect(manager.sanitize("Paket-Munch")).to.equal("paket_munch");
        });
    });

    describe("packageId", () => {
        it("should use sanitized tracking number", () => {
            const delivery = makeDelivery({ tracking_number: "DHL-123456" });
            expect(manager.packageId(delivery)).to.equal("dhl_123456");
        });

        it("should append extra_information if present", () => {
            const delivery = makeDelivery({
                tracking_number: "ABC123",
                extra_information: "12345",
            });
            expect(manager.packageId(delivery)).to.equal("abc123_12345");
        });

        it("should not append extra info if empty", () => {
            const delivery = makeDelivery({
                tracking_number: "ABC123",
                extra_information: "",
            });
            expect(manager.packageId(delivery)).to.equal("abc123");
        });

        it("should not append extra info if undefined", () => {
            const delivery = makeDelivery({ tracking_number: "ABC123" });
            delete delivery.extra_information;
            expect(manager.packageId(delivery)).to.equal("abc123");
        });
    });

    describe("updateDelivery", () => {
        it("should create device object with description as name", async () => {
            const delivery = makeDelivery({ description: "My DHL Package" });
            await manager.updateDelivery(delivery, "DHL");

            const pkgId = manager.packageId(delivery);
            const device = adapter.objects.get(`deliveries.${pkgId}`);
            expect(device).to.not.be.undefined;
            expect(device!.type).to.equal("device");
            expect(device!.common.name).to.equal("My DHL Package");
        });

        it("should use tracking number as fallback name when description is empty", async () => {
            const delivery = makeDelivery({ description: "", tracking_number: "TRK99" });
            await manager.updateDelivery(delivery, "DHL");

            const pkgId = manager.packageId(delivery);
            const device = adapter.objects.get(`deliveries.${pkgId}`);
            expect(device!.common.name).to.equal("Package TRK99");
        });

        it("should create carrier state with correct value", async () => {
            const delivery = makeDelivery();
            await manager.updateDelivery(delivery, "DHL Express");

            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.carrier`);
            expect(state?.val).to.equal("DHL Express");
            expect(state?.ack).to.be.true;
        });

        it("should set status label in German when language is de", async () => {
            const delivery = makeDelivery({ status_code: "2" });
            await manager.updateDelivery(delivery, "DHL");

            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.status`);
            expect(state?.val).to.equal("Unterwegs");
        });

        it("should set status label in English when language is en", async () => {
            adapter = createMockAdapter("en");
            manager = new StateManager(adapter as never);

            const delivery = makeDelivery({ status_code: "4" });
            await manager.updateDelivery(delivery, "DHL");

            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.status`);
            expect(state?.val).to.equal("Out for Delivery");
        });

        it("should set statusCode as number", async () => {
            const delivery = makeDelivery({ status_code: "8" });
            await manager.updateDelivery(delivery, "DHL");

            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.statusCode`);
            expect(state?.val).to.equal(8);
        });

        it("should handle unknown status code", async () => {
            const delivery = makeDelivery({ status_code: "99" });
            await manager.updateDelivery(delivery, "DHL");

            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.status`);
            expect(state?.val).to.equal("Unknown (99)");
        });

        it("should handle non-numeric status code", async () => {
            const delivery = makeDelivery({ status_code: "abc" });
            await manager.updateDelivery(delivery, "DHL");

            const pkgId = manager.packageId(delivery);
            const statusCode = adapter.states.get(`deliveries.${pkgId}.statusCode`);
            expect(statusCode?.val).to.equal(0);
            const status = adapter.states.get(`deliveries.${pkgId}.status`);
            expect(status?.val).to.equal("Zugestellt"); // status code 0 = Delivered
        });

        it("should set trackingNumber as original string", async () => {
            const delivery = makeDelivery({ tracking_number: "DHL-ABC-123" });
            await manager.updateDelivery(delivery, "DHL");

            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.trackingNumber`);
            expect(state?.val).to.equal("DHL-ABC-123");
        });

        it("should set extraInfo or empty string", async () => {
            const delivery = makeDelivery({ extra_information: "PLZ12345" });
            await manager.updateDelivery(delivery, "DHL");

            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.extraInfo`);
            expect(state?.val).to.equal("PLZ12345");
        });

        it("should set empty extraInfo when undefined", async () => {
            const delivery = makeDelivery();
            delete delivery.extra_information;
            await manager.updateDelivery(delivery, "DHL");

            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.extraInfo`);
            expect(state?.val).to.equal("");
        });

        it("should set lastUpdated as ISO string", async () => {
            const delivery = makeDelivery();
            await manager.updateDelivery(delivery, "DHL");

            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.lastUpdated`);
            expect(state?.val).to.be.a("string");
            // Verify it's a valid ISO date
            const date = new Date(state?.val as string);
            expect(date.getTime()).to.not.be.NaN;
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
                expect(
                    adapter.states.has(`deliveries.${pkgId}.${state}`),
                    `Missing state: ${state}`,
                ).to.be.true;
            }
        });

        it("should create state objects with correct types", async () => {
            const delivery = makeDelivery();
            await manager.updateDelivery(delivery, "DHL");

            const pkgId = manager.packageId(delivery);
            const carrierObj = adapter.objects.get(`deliveries.${pkgId}.carrier`);
            expect(carrierObj?.common.type).to.equal("string");
            expect(carrierObj?.common.role).to.equal("text");
            expect(carrierObj?.common.read).to.be.true;
            expect(carrierObj?.common.write).to.be.false;

            const codeObj = adapter.objects.get(`deliveries.${pkgId}.statusCode`);
            expect(codeObj?.common.type).to.equal("number");
            expect(codeObj?.common.role).to.equal("value");
        });
    });

    describe("status labels", () => {
        it("should have all status codes 0-8 in German", () => {
            for (let i = 0; i <= 8; i++) {
                expect(STATUS_LABELS_DE[i], `Missing DE label for code ${i}`).to.be.a("string");
                expect(STATUS_LABELS_DE[i].length).to.be.greaterThan(0);
            }
        });

        it("should have all status codes 0-8 in English", () => {
            for (let i = 0; i <= 8; i++) {
                expect(STATUS_LABELS_EN[i], `Missing EN label for code ${i}`).to.be.a("string");
                expect(STATUS_LABELS_EN[i].length).to.be.greaterThan(0);
            }
        });

        it("should have matching key sets for DE and EN", () => {
            const deKeys = Object.keys(STATUS_LABELS_DE).sort();
            const enKeys = Object.keys(STATUS_LABELS_EN).sort();
            expect(deKeys).to.deep.equal(enKeys);
        });

        it("should map all codes through updateDelivery in DE", async () => {
            for (let code = 0; code <= 8; code++) {
                adapter = createMockAdapter("de");
                manager = new StateManager(adapter as never);
                const delivery = makeDelivery({ status_code: String(code), tracking_number: `trk${code}` });
                await manager.updateDelivery(delivery, "Test");

                const pkgId = manager.packageId(delivery);
                const status = adapter.states.get(`deliveries.${pkgId}.status`);
                expect(status?.val, `Status for code ${code}`).to.equal(STATUS_LABELS_DE[code]);
            }
        });

        it("should map all codes through updateDelivery in EN", async () => {
            for (let code = 0; code <= 8; code++) {
                adapter = createMockAdapter("en");
                manager = new StateManager(adapter as never);
                const delivery = makeDelivery({ status_code: String(code), tracking_number: `trk${code}` });
                await manager.updateDelivery(delivery, "Test");

                const pkgId = manager.packageId(delivery);
                const status = adapter.states.get(`deliveries.${pkgId}.status`);
                expect(status?.val, `Status for code ${code}`).to.equal(STATUS_LABELS_EN[code]);
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
            expect(state?.val).to.equal("");
        });

        it("should return empty string for non-trackable status (frozen)", async () => {
            const delivery = makeDelivery({
                status_code: "1",
                timestamp_expected: Math.floor(Date.now() / 1000) + 3600,
            });
            await manager.updateDelivery(delivery, "DHL");

            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.deliveryWindow`);
            expect(state?.val).to.equal("");
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
            expect(state?.val).to.equal("14:00 - 16:00");
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
            expect(state?.val).to.equal("10:30");
        });

        it("should return empty string when no timestamps", async () => {
            const delivery = makeDelivery({ status_code: "2" });
            await manager.updateDelivery(delivery, "DHL");

            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.deliveryWindow`);
            expect(state?.val).to.equal("");
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
            expect(state?.val).to.equal("09:00");
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
            expect(state?.val).to.equal("");
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
            expect(state?.val).to.equal("heute");
        });

        it("should return 'today' for today delivery in English", async () => {
            adapter = createMockAdapter("en");
            manager = new StateManager(adapter as never);

            const today = new Date();
            today.setHours(15, 0, 0, 0);

            const delivery = makeDelivery({
                status_code: "2",
                timestamp_expected: Math.floor(today.getTime() / 1000),
            });
            await manager.updateDelivery(delivery, "DHL");

            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.deliveryEstimate`);
            expect(state?.val).to.equal("today");
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
            expect(state?.val).to.equal("morgen");
        });

        it("should return 'tomorrow' for tomorrow delivery in English", async () => {
            adapter = createMockAdapter("en");
            manager = new StateManager(adapter as never);

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
            expect(state?.val).to.equal("tomorrow");
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
            expect(state?.val).to.equal("in 3 Tagen");
        });

        it("should return 'in %d days' for future delivery in English", async () => {
            adapter = createMockAdapter("en");
            manager = new StateManager(adapter as never);

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
            expect(state?.val).to.equal("in 5 days");
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
            expect(state?.val).to.equal("\u00fcberfällig");
        });

        it("should return 'overdue' for overdue delivery in English", async () => {
            adapter = createMockAdapter("en");
            manager = new StateManager(adapter as never);

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
            expect(state?.val).to.equal("overdue");
        });

        it("should use date_expected as fallback when no timestamp", async () => {
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            const dateStr = tomorrow.toISOString().split("T")[0]; // YYYY-MM-DD

            const delivery = makeDelivery({
                status_code: "2",
                date_expected: dateStr,
            });
            await manager.updateDelivery(delivery, "DHL");

            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.deliveryEstimate`);
            expect(state?.val).to.equal("morgen");
        });

        it("should return empty string when no expected date at all", async () => {
            const delivery = makeDelivery({ status_code: "2" });
            await manager.updateDelivery(delivery, "DHL");

            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.deliveryEstimate`);
            expect(state?.val).to.equal("");
        });

        it("should return empty string for invalid date", async () => {
            const delivery = makeDelivery({
                status_code: "2",
                date_expected: "not-a-date",
            });
            await manager.updateDelivery(delivery, "DHL");

            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.deliveryEstimate`);
            expect(state?.val).to.equal("");
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
            expect(state?.val).to.equal("Arrived at sort facility - 2026-04-04 10:30");
        });

        it("should return only event when no date", async () => {
            const delivery = makeDelivery({
                events: [{ event: "Package picked up", date: "" }],
            });
            await manager.updateDelivery(delivery, "DHL");

            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.lastEvent`);
            expect(state?.val).to.equal("Package picked up");
        });

        it("should return empty string when no events", async () => {
            const delivery = makeDelivery({ events: [] });
            await manager.updateDelivery(delivery, "DHL");

            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.lastEvent`);
            expect(state?.val).to.equal("");
        });

        it("should return empty string when events is undefined", async () => {
            const delivery = makeDelivery();
            delete delivery.events;
            await manager.updateDelivery(delivery, "DHL");

            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.lastEvent`);
            expect(state?.val).to.equal("");
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
            expect(state?.val).to.equal("Delivered - 2026-04-04");
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
            expect(state?.val).to.equal("Berlin Hub");
        });

        it("should return empty string when location is undefined", async () => {
            const delivery = makeDelivery({
                events: [{ event: "Arrived", date: "2026-04-04" }],
            });
            await manager.updateDelivery(delivery, "DHL");

            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.lastLocation`);
            expect(state?.val).to.equal("");
        });

        it("should return empty string when no events", async () => {
            const delivery = makeDelivery();
            delete delivery.events;
            await manager.updateDelivery(delivery, "DHL");

            const pkgId = manager.packageId(delivery);
            const state = adapter.states.get(`deliveries.${pkgId}.lastLocation`);
            expect(state?.val).to.equal("");
        });
    });

    describe("updateSummary", () => {
        it("should create summary channel", async () => {
            await manager.updateSummary([]);

            const channel = adapter.objects.get("summary");
            expect(channel).to.not.be.undefined;
            expect(channel!.type).to.equal("channel");
        });

        it("should set activeCount to 0 for empty deliveries", async () => {
            await manager.updateSummary([]);

            const state = adapter.states.get("summary.activeCount");
            expect(state?.val).to.equal(0);
            expect(state?.ack).to.be.true;
        });

        it("should count active deliveries", async () => {
            const deliveries = [
                makeDelivery({ status_code: "2", tracking_number: "A" }),
                makeDelivery({ status_code: "4", tracking_number: "B" }),
                makeDelivery({ status_code: "8", tracking_number: "C" }),
            ];
            await manager.updateSummary(deliveries);

            const state = adapter.states.get("summary.activeCount");
            expect(state?.val).to.equal(3);
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
            expect(state?.val).to.equal(1);
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
            expect(state?.val).to.equal(0);
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
            expect(state?.val).to.equal("10:00 - 16:00");
        });

        it("should return empty delivery window when no today deliveries", async () => {
            await manager.updateSummary([]);

            const state = adapter.states.get("summary.deliveryWindow");
            expect(state?.val).to.equal("");
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
            expect(adapter.objects.has(`deliveries.${keepId}`)).to.be.true;
            expect(adapter.states.has(`deliveries.${keepId}.carrier`)).to.be.true;

            // The removed delivery should be gone
            expect(adapter.objects.has(`deliveries.${removeId}`)).to.be.false;
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
            expect(adapter.objects.size).to.equal(objectsBefore);
        });

        it("should handle empty active IDs", async () => {
            const d1 = makeDelivery({ tracking_number: "OLD", status_code: "2" });
            await manager.updateDelivery(d1, "DHL");

            await manager.cleanupDeliveries([]);

            // Everything should be removed
            expect(adapter.objects.has(`deliveries.${manager.packageId(d1)}`)).to.be.false;
        });
    });
});
