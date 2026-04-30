import { expect } from "chai";
import { StateManager, resolveLanguage } from "./state-manager";
import { STATUS_LABELS, SUPPORTED_LANGUAGES, FALLBACK_LANGUAGE } from "./types";
import type { ParcelDelivery } from "./types";

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
  config: { autoRemoveDelivered: boolean };
  objects: Map<string, ObjectDef>;
  states: Map<string, StateValue>;
  log: { debug: (msg: string) => void };
  extendObjectAsync: (id: string, obj: Partial<ObjectDef>) => Promise<void>;
  setObjectNotExistsAsync: (id: string, obj: ObjectDef) => Promise<void>;
  setStateAsync: (id: string, state: StateValue) => Promise<void>;
  delObjectAsync: (id: string, opts?: { recursive: boolean }) => Promise<void>;
  getObjectViewAsync: (
    design: string,
    search: string,
    params: { startkey: string; endkey: string },
  ) => Promise<{ rows: ObjectViewRow[] }>;
}

function createMockAdapter(): MockAdapter {
  const objects = new Map<string, ObjectDef>();
  const states = new Map<string, StateValue>();
  const debugMessages: string[] = [];

  return {
    namespace: "parcelapp.0",
    config: { autoRemoveDelivered: true },
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
    setObjectNotExistsAsync: async (id: string, obj: ObjectDef): Promise<void> => {
      if (!objects.has(id)) {
        objects.set(id, obj);
      }
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
    adapter = createMockAdapter();
    manager = new StateManager(adapter as never, "de");
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
      adapter = createMockAdapter();
      manager = new StateManager(adapter as never, "en");

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
        expect(adapter.states.has(`deliveries.${pkgId}.${state}`), `Missing state: ${state}`).to.be.true;
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
        expect(STATUS_LABELS.de[i], `Missing DE label for code ${i}`).to.be.a("string");
        expect(STATUS_LABELS.de[i].length).to.be.greaterThan(0);
      }
    });

    it("should have all status codes 0-8 in English", () => {
      for (let i = 0; i <= 8; i++) {
        expect(STATUS_LABELS.en[i], `Missing EN label for code ${i}`).to.be.a("string");
        expect(STATUS_LABELS.en[i].length).to.be.greaterThan(0);
      }
    });

    it("should have matching key sets for DE and EN", () => {
      const deKeys = Object.keys(STATUS_LABELS.de).sort();
      const enKeys = Object.keys(STATUS_LABELS.en).sort();
      expect(deKeys).to.deep.equal(enKeys);
    });

    it("should map all codes through updateDelivery in DE", async () => {
      for (let code = 0; code <= 8; code++) {
        adapter = createMockAdapter();
        manager = new StateManager(adapter as never, "de");
        const delivery = makeDelivery({ status_code: String(code), tracking_number: `trk${code}` });
        await manager.updateDelivery(delivery, "Test");

        const pkgId = manager.packageId(delivery);
        const status = adapter.states.get(`deliveries.${pkgId}.status`);
        expect(status?.val, `Status for code ${code}`).to.equal(STATUS_LABELS.de[code]);
      }
    });

    it("should map all codes through updateDelivery in EN", async () => {
      for (let code = 0; code <= 8; code++) {
        adapter = createMockAdapter();
        manager = new StateManager(adapter as never, "en");
        const delivery = makeDelivery({ status_code: String(code), tracking_number: `trk${code}` });
        await manager.updateDelivery(delivery, "Test");

        const pkgId = manager.packageId(delivery);
        const status = adapter.states.get(`deliveries.${pkgId}.status`);
        expect(status?.val, `Status for code ${code}`).to.equal(STATUS_LABELS.en[code]);
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
      adapter = createMockAdapter();
      manager = new StateManager(adapter as never, "en");

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
      adapter = createMockAdapter();
      manager = new StateManager(adapter as never, "en");

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
      adapter = createMockAdapter();
      manager = new StateManager(adapter as never, "en");

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
      adapter = createMockAdapter();
      manager = new StateManager(adapter as never, "en");

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
      const dateStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;

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
    it("should create all summary states under the summary channel", async () => {
      await manager.updateSummary([]);

      // The `summary` channel itself is declared via io-package.json instanceObjects;
      // StateManager only creates the states below it.
      expect(adapter.objects.has("summary.activeCount")).to.be.true;
      expect(adapter.objects.has("summary.todayCount")).to.be.true;
      expect(adapter.objects.has("summary.deliveryWindow")).to.be.true;
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

  describe("API-drift guards", () => {
    describe("sanitize", () => {
      it("should return 'unknown' for null", () => {
        expect(manager.sanitize(null as unknown as string)).to.equal("unknown");
      });

      it("should return 'unknown' for undefined", () => {
        expect(manager.sanitize(undefined as unknown as string)).to.equal("unknown");
      });

      it("should return 'unknown' for number", () => {
        expect(manager.sanitize(42 as unknown as string)).to.equal("unknown");
      });

      it("should return 'unknown' for object", () => {
        expect(manager.sanitize({} as unknown as string)).to.equal("unknown");
      });

      it("should return 'unknown' for array", () => {
        expect(manager.sanitize([] as unknown as string)).to.equal("unknown");
      });
    });

    describe("parseStatus", () => {
      it("should accept number status_code (API drift)", () => {
        const delivery = makeDelivery({
          status_code: 2 as unknown as string,
        });
        expect(manager.parseStatus(delivery)).to.equal(2);
      });

      it("should truncate fractional numbers", () => {
        const delivery = makeDelivery({
          status_code: 2.7 as unknown as string,
        });
        expect(manager.parseStatus(delivery)).to.equal(2);
      });

      it("should return 0 for NaN number", () => {
        const delivery = makeDelivery({
          status_code: NaN as unknown as string,
        });
        expect(manager.parseStatus(delivery)).to.equal(0);
      });

      it("should return 0 for Infinity", () => {
        const delivery = makeDelivery({
          status_code: Infinity as unknown as string,
        });
        expect(manager.parseStatus(delivery)).to.equal(0);
      });

      it("should return 0 for null", () => {
        const delivery = makeDelivery({
          status_code: null as unknown as string,
        });
        expect(manager.parseStatus(delivery)).to.equal(0);
      });

      it("should return 0 for object", () => {
        const delivery = makeDelivery({
          status_code: {} as unknown as string,
        });
        expect(manager.parseStatus(delivery)).to.equal(0);
      });

      it("should return 0 for non-numeric string", () => {
        const delivery = makeDelivery({ status_code: "abc" });
        expect(manager.parseStatus(delivery)).to.equal(0);
      });
    });

    describe("packageId", () => {
      it("should ignore non-string extra_information (number)", () => {
        const delivery = makeDelivery({
          tracking_number: "ABC",
          extra_information: 12345 as unknown as string,
        });
        expect(manager.packageId(delivery)).to.equal("abc");
      });

      it("should ignore non-string extra_information (object)", () => {
        const delivery = makeDelivery({
          tracking_number: "ABC",
          extra_information: { foo: "bar" } as unknown as string,
        });
        expect(manager.packageId(delivery)).to.equal("abc");
      });

      it("should handle non-string tracking_number", () => {
        const delivery = makeDelivery({
          tracking_number: null as unknown as string,
        });
        expect(manager.packageId(delivery)).to.equal("unknown");
      });
    });

    describe("updateDelivery with malformed fields", () => {
      it("should handle non-string description (number)", async () => {
        const delivery = makeDelivery({
          description: 42 as unknown as string,
          tracking_number: "TRK1",
        });
        await manager.updateDelivery(delivery, "DHL");

        const pkgId = manager.packageId(delivery);
        const state = adapter.states.get(`deliveries.${pkgId}.description`);
        expect(state?.val).to.equal("");
        const device = adapter.objects.get(`deliveries.${pkgId}`);
        expect(device!.common.name).to.equal("Package TRK1");
      });

      it("should handle non-string tracking_number", async () => {
        const delivery = makeDelivery({
          tracking_number: 999 as unknown as string,
          description: "",
        });
        await manager.updateDelivery(delivery, "DHL");

        const pkgId = manager.packageId(delivery);
        const state = adapter.states.get(`deliveries.${pkgId}.trackingNumber`);
        expect(state?.val).to.equal("");
      });

      it("should handle non-string extra_information", async () => {
        const delivery = makeDelivery({
          extra_information: { zip: "12345" } as unknown as string,
        });
        await manager.updateDelivery(delivery, "DHL");

        const pkgId = manager.packageId(delivery);
        const state = adapter.states.get(`deliveries.${pkgId}.extraInfo`);
        expect(state?.val).to.equal("");
      });

      it("should handle events as non-array (object)", async () => {
        const delivery = makeDelivery({
          events: { event: "x", date: "y" } as unknown as never,
        });
        await manager.updateDelivery(delivery, "DHL");

        const pkgId = manager.packageId(delivery);
        expect(adapter.states.get(`deliveries.${pkgId}.lastEvent`)?.val).to.equal("");
        expect(adapter.states.get(`deliveries.${pkgId}.lastLocation`)?.val).to.equal("");
      });

      it("should handle events with null first entry", async () => {
        const delivery = makeDelivery({
          events: [null as unknown as { event: string; date: string }],
        });
        await manager.updateDelivery(delivery, "DHL");

        const pkgId = manager.packageId(delivery);
        expect(adapter.states.get(`deliveries.${pkgId}.lastEvent`)?.val).to.equal("");
        expect(adapter.states.get(`deliveries.${pkgId}.lastLocation`)?.val).to.equal("");
      });

      it("should handle event with non-string fields", async () => {
        const delivery = makeDelivery({
          events: [
            {
              event: 123 as unknown as string,
              date: null as unknown as string,
              location: 42 as unknown as string,
            },
          ],
        });
        await manager.updateDelivery(delivery, "DHL");

        const pkgId = manager.packageId(delivery);
        expect(adapter.states.get(`deliveries.${pkgId}.lastEvent`)?.val).to.equal("");
        expect(adapter.states.get(`deliveries.${pkgId}.lastLocation`)?.val).to.equal("");
      });

      it("should handle timestamp_expected as numeric string (API drift)", async () => {
        const now = new Date();
        now.setHours(11, 15, 0, 0);
        const ts = Math.floor(now.getTime() / 1000);

        const delivery = makeDelivery({
          status_code: "2",
          timestamp_expected: String(ts) as unknown as number,
        });
        await manager.updateDelivery(delivery, "DHL");

        const pkgId = manager.packageId(delivery);
        const window = adapter.states.get(`deliveries.${pkgId}.deliveryWindow`);
        expect(window?.val).to.equal("11:15");
      });

      it("should handle timestamp_expected as non-finite value", async () => {
        const delivery = makeDelivery({
          status_code: "2",
          timestamp_expected: NaN as unknown as number,
        });
        await manager.updateDelivery(delivery, "DHL");

        const pkgId = manager.packageId(delivery);
        const window = adapter.states.get(`deliveries.${pkgId}.deliveryWindow`);
        expect(window?.val).to.equal("");
      });

      it("should handle date_expected as non-string (null)", async () => {
        const delivery = makeDelivery({
          status_code: "2",
          date_expected: null as unknown as string,
        });
        await manager.updateDelivery(delivery, "DHL");

        const pkgId = manager.packageId(delivery);
        const estimate = adapter.states.get(`deliveries.${pkgId}.deliveryEstimate`);
        expect(estimate?.val).to.equal("");
      });

      it("should handle timestamp_expected_end as garbage", async () => {
        const start = new Date();
        start.setHours(9, 0, 0, 0);

        const delivery = makeDelivery({
          status_code: "2",
          timestamp_expected: Math.floor(start.getTime() / 1000),
          timestamp_expected_end: "not-a-number" as unknown as number,
        });
        await manager.updateDelivery(delivery, "DHL");

        const pkgId = manager.packageId(delivery);
        const window = adapter.states.get(`deliveries.${pkgId}.deliveryWindow`);
        expect(window?.val).to.equal("09:00");
      });

      it("should handle numeric status_code (API drift)", async () => {
        const delivery = makeDelivery({
          status_code: 4 as unknown as string,
        });
        await manager.updateDelivery(delivery, "DHL");

        const pkgId = manager.packageId(delivery);
        expect(adapter.states.get(`deliveries.${pkgId}.statusCode`)?.val).to.equal(4);
        expect(adapter.states.get(`deliveries.${pkgId}.status`)?.val).to.equal("In Zustellung");
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

  describe("multilingual labels", () => {
    const EXPECTED_LANGUAGES = ["de", "en", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"];

    it("should cover all 11 ioBroker languages", () => {
      expect(SUPPORTED_LANGUAGES.sort()).to.deep.equal([...EXPECTED_LANGUAGES].sort());
    });

    it("should define status codes 0-8 for every language", () => {
      for (const lang of EXPECTED_LANGUAGES) {
        const labels = STATUS_LABELS[lang];
        expect(labels, `Missing STATUS_LABELS.${lang}`).to.be.an("object");
        for (let code = 0; code <= 8; code++) {
          expect(labels[code], `${lang} missing code ${code}`).to.be.a("string");
          expect(labels[code].length).to.be.greaterThan(0);
        }
      }
    });

    it("should use the selected language for status strings", async () => {
      adapter = createMockAdapter();
      manager = new StateManager(adapter as never, "fr");
      const delivery = makeDelivery({ status_code: "2" });
      await manager.updateDelivery(delivery, "DHL");

      const pkgId = manager.packageId(delivery);
      expect(adapter.states.get(`deliveries.${pkgId}.status`)?.val).to.equal("En transit");
    });

    it("should localize the today estimate in every language", async () => {
      for (const lang of EXPECTED_LANGUAGES) {
        adapter = createMockAdapter();
        manager = new StateManager(adapter as never, lang);

        const now = new Date();
        now.setHours(14, 0, 0, 0);

        const delivery = makeDelivery({
          status_code: "2",
          tracking_number: `trk_${lang.replace("-", "_")}`,
          timestamp_expected: Math.floor(now.getTime() / 1000),
        });
        await manager.updateDelivery(delivery, "DHL");

        const pkgId = manager.packageId(delivery);
        const estimate = adapter.states.get(`deliveries.${pkgId}.deliveryEstimate`)?.val;
        expect(estimate, `today label in ${lang}`).to.be.a("string");
        expect((estimate as string).length, `today label in ${lang}`).to.be.greaterThan(0);
      }
    });
  });

  describe("resolveLanguage", () => {
    it("should pass through all supported languages", () => {
      for (const lang of SUPPORTED_LANGUAGES) {
        expect(resolveLanguage(lang)).to.equal(lang);
      }
    });

    it("should fall back to English for unknown language codes", () => {
      expect(resolveLanguage("jp")).to.equal(FALLBACK_LANGUAGE);
      expect(resolveLanguage("xx")).to.equal(FALLBACK_LANGUAGE);
      expect(resolveLanguage("")).to.equal(FALLBACK_LANGUAGE);
    });

    it("should fall back to English for non-string inputs", () => {
      expect(resolveLanguage(undefined)).to.equal(FALLBACK_LANGUAGE);
      expect(resolveLanguage(null)).to.equal(FALLBACK_LANGUAGE);
      expect(resolveLanguage(42)).to.equal(FALLBACK_LANGUAGE);
      expect(resolveLanguage({})).to.equal(FALLBACK_LANGUAGE);
    });

    it("FALLBACK_LANGUAGE must itself be a supported language", () => {
      expect(SUPPORTED_LANGUAGES).to.include(FALLBACK_LANGUAGE);
    });
  });

  describe("todayCount language-independence", () => {
    // Regression: before the isToday refactor, summary.todayCount was
    // filtered by string-matching the estimate against "heute"/"today",
    // so non-DE/EN languages always reported 0.
    it("should count today deliveries for every supported language", async () => {
      for (const lang of SUPPORTED_LANGUAGES) {
        adapter = createMockAdapter();
        manager = new StateManager(adapter as never, lang);

        const now = new Date();
        now.setHours(15, 0, 0, 0);
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);

        const deliveries = [
          makeDelivery({
            status_code: "2",
            tracking_number: "TODAY",
            timestamp_expected: Math.floor(now.getTime() / 1000),
          }),
          makeDelivery({
            status_code: "4",
            tracking_number: "NOT_TODAY",
            timestamp_expected: Math.floor(tomorrow.getTime() / 1000),
          }),
        ];
        await manager.updateSummary(deliveries);

        const count = adapter.states.get("summary.todayCount")?.val;
        expect(count, `todayCount in ${lang}`).to.equal(1);
      }
    });
  });
});
