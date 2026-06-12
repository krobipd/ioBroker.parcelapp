import { vi } from "vitest";

// Stub the adapter-core base so ParcelappAdapter can be instantiated without
// the ioBroker runtime. Tests drive the private methods directly and assert
// on the injected fakes (client/stateManager factories below).
vi.mock("@iobroker/adapter-core", () => {
  class Adapter {
    public log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    public namespace = "parcelapp.0";
    public adapterDir = "/tmp";
    public config: Record<string, unknown> = {};
    public on = vi.fn();
    public setStateAsync = vi.fn(async () => {});
    public setStateChangedAsync = vi.fn(async () => {});
    public setState = vi.fn(async () => {});
    public setInterval = vi.fn(() => ({}) as unknown);
    public clearInterval = vi.fn();
    public sendTo = vi.fn();
    public getForeignObjectAsync = vi.fn(async () => ({ common: { language: "de" } }));
    public getObjectAsync = vi.fn(async () => null);
    public delObjectAsync = vi.fn(async () => {});
    constructor(_opts: unknown) {}
  }
  return {
    Adapter,
    I18n: {
      init: vi.fn(async () => {}),
      getTranslatedObject: (k: string) => ({ en: k }),
      translate: (k: string) => k,
    },
  };
});

import { ParcelappAdapter } from "./main";
import type { ParcelDelivery } from "./lib/types";

interface FakeClient {
  getDeliveries: ReturnType<typeof vi.fn>;
  getCarrierName: ReturnType<typeof vi.fn>;
  addDelivery: ReturnType<typeof vi.fn>;
  testConnection: ReturnType<typeof vi.fn>;
  cancelAll: ReturnType<typeof vi.fn>;
}

interface FakeStateMgr {
  parseStatus: ReturnType<typeof vi.fn>;
  resetPollState: ReturnType<typeof vi.fn>;
  packageId: ReturnType<typeof vi.fn>;
  updateDelivery: ReturnType<typeof vi.fn>;
  cleanupDeliveries: ReturnType<typeof vi.fn>;
  updateSummary: ReturnType<typeof vi.fn>;
}

function makeDelivery(overrides: Partial<ParcelDelivery> = {}): ParcelDelivery {
  return {
    carrier_code: "dhl",
    description: "Test",
    status_code: "2",
    tracking_number: "TRK1",
    ...overrides,
  };
}

function codeError(message: string, code: string, extra?: Record<string, unknown>): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  if (extra) {
    Object.assign(err, extra);
  }
  return err;
}

/** Typed access to the private fields/methods the orchestration tests drive. */
function internalOf(adapter: ParcelappAdapter): {
  client: FakeClient | null;
  stateManager: FakeStateMgr | null;
  isPolling: boolean;
  lastPollTime: number;
  rateLimitedUntil: number;
  lastErrorCode: string;
  failedDeliveries: Set<string>;
  testClients: Set<{ cancelAll: () => void }>;
  pollTimer: unknown;
  config: Record<string, unknown>;
  log: { debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  setStateAsync: ReturnType<typeof vi.fn>;
  setStateChangedAsync: ReturnType<typeof vi.fn>;
  setInterval: ReturnType<typeof vi.fn>;
  clearInterval: ReturnType<typeof vi.fn>;
  sendTo: ReturnType<typeof vi.fn>;
  classifyError: (err: Error & { code?: string }) => string;
  onReady: () => Promise<void>;
  onUnload: (cb: () => void) => void;
  onMessage: (obj: unknown) => Promise<void>;
  poll: (options?: { force?: boolean }) => Promise<void>;
} {
  return adapter as unknown as ReturnType<typeof internalOf>;
}

/** Build an adapter with fake client/stateManager factories + valid config. */
function setup(configOverrides: Record<string, unknown> = {}): {
  adapter: ParcelappAdapter;
  client: FakeClient;
  stateMgr: FakeStateMgr;
} {
  const adapter = new ParcelappAdapter();
  const i = internalOf(adapter);
  i.config.apiKey = "0123456789abcdef";
  i.config.pollInterval = 10;
  i.config.autoRemoveDelivered = true;
  Object.assign(i.config, configOverrides);

  const client: FakeClient = {
    getDeliveries: vi.fn(async () => [makeDelivery()]),
    getCarrierName: vi.fn(async () => "DHL"),
    addDelivery: vi.fn(async () => ({ success: true })),
    testConnection: vi.fn(async () => ({ success: true, message: "Connection successful" })),
    cancelAll: vi.fn(),
  };
  const stateMgr: FakeStateMgr = {
    parseStatus: vi.fn((d: ParcelDelivery) => parseInt(String(d.status_code), 10) || 0),
    resetPollState: vi.fn(),
    packageId: vi.fn((d: ParcelDelivery) => String(d.tracking_number).toLowerCase()),
    updateDelivery: vi.fn(async () => {}),
    cleanupDeliveries: vi.fn(async () => {}),
    updateSummary: vi.fn(async () => {}),
  };
  const internal = adapter as unknown as {
    makeClient: () => FakeClient;
    makeStateManager: () => FakeStateMgr;
  };
  internal.makeClient = () => client;
  internal.makeStateManager = () => stateMgr;
  return { adapter, client, stateMgr };
}

/** setup() + onReady() so client/stateManager are wired like in production. */
async function setupReady(configOverrides: Record<string, unknown> = {}): Promise<{
  adapter: ParcelappAdapter;
  client: FakeClient;
  stateMgr: FakeStateMgr;
}> {
  const ctx = setup(configOverrides);
  await internalOf(ctx.adapter).onReady();
  // Clear the 60s throttle so each test's poll() runs without force.
  internalOf(ctx.adapter).lastPollTime = 0;
  return ctx;
}

describe("ParcelappAdapter classifyError", () => {
  const cases: Array<[string, Error & { code?: string }, string]> = [
    ["RATE_LIMITED", codeError("429", "RATE_LIMITED"), "RATE_LIMITED"],
    ["INVALID_API_KEY", codeError("401", "INVALID_API_KEY"), "INVALID_API_KEY"],
    ["FORBIDDEN", codeError("403", "FORBIDDEN"), "FORBIDDEN"],
    ["ENOTFOUND", codeError("dns", "ENOTFOUND"), "NETWORK"],
    ["ECONNREFUSED", codeError("refused", "ECONNREFUSED"), "NETWORK"],
    ["ECONNRESET", codeError("reset", "ECONNRESET"), "NETWORK"],
    ["ENETUNREACH", codeError("net", "ENETUNREACH"), "NETWORK"],
    ["EHOSTUNREACH", codeError("host", "EHOSTUNREACH"), "NETWORK"],
    ["EAI_AGAIN", codeError("dns-temp", "EAI_AGAIN"), "NETWORK"],
    ["ETIMEDOUT", codeError("slow", "ETIMEDOUT"), "TIMEOUT"],
    ["timeout in message", new Error("Request timeout"), "TIMEOUT"],
    ["other code", codeError("denied", "EACCES"), "EACCES"],
    ["no code", new Error("weird"), "UNKNOWN"],
  ];
  for (const [label, err, expected] of cases) {
    it(`classifies ${label} as ${expected}`, () => {
      const { adapter } = setup();
      expect(internalOf(adapter).classifyError(err)).toBe(expected);
    });
  }
});

describe("ParcelappAdapter onReady", () => {
  it("refuses to start without a plausible API key", async () => {
    const { adapter, client } = setup({ apiKey: "short" });
    const i = internalOf(adapter);
    await i.onReady();
    expect(i.log.error).toHaveBeenCalledWith(expect.stringContaining("No valid API key"));
    expect(i.client).toBeNull();
    expect(client.getDeliveries).not.toHaveBeenCalled();
  });

  it("happy path: polls once and schedules the interval", async () => {
    const { adapter, client, stateMgr } = setup();
    const i = internalOf(adapter);
    await i.onReady();
    expect(client.getDeliveries).toHaveBeenCalledTimes(1);
    expect(stateMgr.updateSummary).toHaveBeenCalled();
    expect(i.setInterval).toHaveBeenCalledTimes(1);
    expect(i.log.info).toHaveBeenCalledWith(expect.stringContaining("polling every 10 minutes"));
  });

  it("reports disconnected before the first poll", async () => {
    const { adapter } = setup();
    const i = internalOf(adapter);
    await i.onReady();
    expect(i.setStateAsync.mock.calls[0]).toEqual(["info.connection", { val: false, ack: true }]);
  });

  it("catches a failing boot step instead of crashing", async () => {
    const { adapter } = setup();
    const i = internalOf(adapter);
    i.setStateAsync.mockRejectedValueOnce(new Error("db down"));
    await i.onReady();
    expect(i.log.error).toHaveBeenCalledWith(expect.stringContaining("onReady failed: db down"));
  });

  it("removes the obsolete summary.json state from pre-0.2.0 installs", async () => {
    const { adapter } = setup();
    const i = internalOf(adapter);
    (adapter as unknown as { getObjectAsync: ReturnType<typeof vi.fn> }).getObjectAsync.mockResolvedValueOnce({
      type: "state",
    });
    await i.onReady();
    expect((adapter as unknown as { delObjectAsync: ReturnType<typeof vi.fn> }).delObjectAsync).toHaveBeenCalledWith(
      "summary.json",
    );
  });
});

describe("ParcelappAdapter onUnload", () => {
  it("clears the timer, cancels prod + test clients and always calls back", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    const testClient = { cancelAll: vi.fn() };
    i.testClients.add(testClient);

    const callback = vi.fn();
    i.onUnload(callback);

    expect(i.clearInterval).toHaveBeenCalled();
    expect(i.pollTimer).toBeUndefined();
    expect(client.cancelAll).toHaveBeenCalled();
    expect(testClient.cancelAll).toHaveBeenCalled();
    expect(i.testClients.size).toBe(0);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("still calls back when cleanup throws", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    client.cancelAll.mockImplementation(() => {
      throw new Error("already closed");
    });
    const callback = vi.fn();
    i.onUnload(callback);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("onUnload error"));
  });
});

describe("ParcelappAdapter poll — guards", () => {
  it("skips overlapping polls (in-flight guard)", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    let release!: (v: ParcelDelivery[]) => void;
    client.getDeliveries.mockImplementationOnce(
      () =>
        new Promise<ParcelDelivery[]>(resolve => {
          release = resolve;
        }),
    );
    const first = i.poll();
    await i.poll(); // must bail via isPolling
    expect(client.getDeliveries).toHaveBeenCalledTimes(2); // onReady + first (the second poll bailed)
    release([]);
    await first;
  });

  it("throttles polls within 60s but lets force bypass the throttle", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    await i.poll(); // sets lastPollTime = now
    client.getDeliveries.mockClear();

    await i.poll(); // within 60s → skipped
    expect(client.getDeliveries).not.toHaveBeenCalled();
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("too soon after last poll"));

    await i.poll({ force: true }); // force bypasses the throttle
    expect(client.getDeliveries).toHaveBeenCalledTimes(1);
  });

  it("the rate-limit cooldown blocks even forced polls", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    i.rateLimitedUntil = Date.now() + 60_000;
    client.getDeliveries.mockClear();
    await i.poll({ force: true });
    expect(client.getDeliveries).not.toHaveBeenCalled();
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("rate limited"));
  });
});

describe("ParcelappAdapter poll — happy path", () => {
  it("updates every delivery, cleans up and refreshes the summary", async () => {
    const { adapter, client, stateMgr } = await setupReady();
    const i = internalOf(adapter);
    const a = makeDelivery({ tracking_number: "A", status_code: "2" });
    const b = makeDelivery({ tracking_number: "B", status_code: "4" });
    client.getDeliveries.mockResolvedValue([a, b]);
    stateMgr.updateDelivery.mockClear();

    await i.poll();

    expect(stateMgr.resetPollState).toHaveBeenCalled();
    expect(stateMgr.updateDelivery).toHaveBeenCalledTimes(2);
    expect(stateMgr.cleanupDeliveries).toHaveBeenCalledWith(["a", "b"]);
    expect(stateMgr.updateSummary).toHaveBeenCalledWith([a, b]);
    expect(i.setStateChangedAsync).toHaveBeenCalledWith("info.connection", { val: true, ack: true });
  });

  it("autoRemove mode requests 'active' and filters delivered out", async () => {
    const { adapter, client, stateMgr } = await setupReady({ autoRemoveDelivered: true });
    const i = internalOf(adapter);
    const active = makeDelivery({ tracking_number: "A", status_code: "2" });
    const delivered = makeDelivery({ tracking_number: "D", status_code: "0" });
    client.getDeliveries.mockResolvedValue([active, delivered]);
    stateMgr.updateDelivery.mockClear();

    await i.poll();

    expect(client.getDeliveries).toHaveBeenLastCalledWith("active");
    expect(stateMgr.updateDelivery).toHaveBeenCalledTimes(1); // delivered filtered out
    expect(stateMgr.updateSummary).toHaveBeenCalledWith([active]);
  });

  it("keep mode requests 'recent' and keeps delivered packages visible", async () => {
    const { adapter, client, stateMgr } = await setupReady({ autoRemoveDelivered: false });
    const i = internalOf(adapter);
    const active = makeDelivery({ tracking_number: "A", status_code: "2" });
    const delivered = makeDelivery({ tracking_number: "D", status_code: "0" });
    client.getDeliveries.mockResolvedValue([active, delivered]);
    stateMgr.updateDelivery.mockClear();

    await i.poll();

    expect(client.getDeliveries).toHaveBeenLastCalledWith("recent");
    expect(stateMgr.updateDelivery).toHaveBeenCalledTimes(2); // delivered stays visible
    expect(stateMgr.updateSummary).toHaveBeenCalledWith([active]); // summary still active-only
  });
});

describe("ParcelappAdapter poll — per-delivery failure dedup", () => {
  it("warns on the first failure, demotes repeats to debug, clears on success", async () => {
    const { adapter, stateMgr } = await setupReady();
    const i = internalOf(adapter);
    stateMgr.updateDelivery.mockRejectedValue(new Error("redis hiccup"));

    await i.poll();
    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to update 'TRK1'"));
    expect(i.failedDeliveries.has("TRK1")).toBe(true);

    i.lastPollTime = 0;
    i.log.warn.mockClear();
    await i.poll();
    expect(i.log.warn).not.toHaveBeenCalled(); // repeat → debug

    stateMgr.updateDelivery.mockResolvedValue(undefined);
    i.lastPollTime = 0;
    await i.poll();
    expect(i.failedDeliveries.has("TRK1")).toBe(false);
  });

  it("a failed delivery is excluded from cleanup so its states survive", async () => {
    const { adapter, client, stateMgr } = await setupReady();
    const i = internalOf(adapter);
    const ok = makeDelivery({ tracking_number: "OK" });
    const bad = makeDelivery({ tracking_number: "BAD" });
    client.getDeliveries.mockResolvedValue([ok, bad]);
    stateMgr.updateDelivery.mockImplementation(async (d: ParcelDelivery) => {
      if (d.tracking_number === "BAD") {
        throw new Error("boom");
      }
    });

    await i.poll();
    expect(stateMgr.cleanupDeliveries).toHaveBeenCalledWith(["ok"]);
  });

  it("prunes failedDeliveries entries for trackings that vanished from the API", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    i.failedDeliveries.add("GONE");
    client.getDeliveries.mockResolvedValue([makeDelivery({ tracking_number: "TRK1" })]);
    await i.poll();
    expect(i.failedDeliveries.has("GONE")).toBe(false);
  });
});

describe("ParcelappAdapter poll — error routing", () => {
  it("RATE_LIMITED sets the clamped cooldown and warns", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    client.getDeliveries.mockRejectedValueOnce(codeError("429", "RATE_LIMITED", { retryAfterSeconds: 120 }));
    await i.poll();
    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("Rate limit hit"));
    expect(i.rateLimitedUntil).toBeGreaterThan(Date.now() + 100_000);
    expect(i.rateLimitedUntil).toBeLessThanOrEqual(Date.now() + 121_000);
  });

  it("RATE_LIMITED with a bogus retry-after falls back to 5 minutes", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    client.getDeliveries.mockRejectedValueOnce(codeError("429", "RATE_LIMITED", { retryAfterSeconds: -5 }));
    await i.poll();
    expect(i.rateLimitedUntil).toBeGreaterThan(Date.now() + 4 * 60_000);
    expect(i.rateLimitedUntil).toBeLessThanOrEqual(Date.now() + 5 * 60_000 + 1000);
  });

  it("a successful poll clears the rate-limit cooldown", async () => {
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    i.rateLimitedUntil = Date.now() - 1; // expired cooldown from a previous 429
    await i.poll();
    expect(i.rateLimitedUntil).toBe(0);
  });

  it("INVALID_API_KEY logs an error on every occurrence (user must fix config)", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    client.getDeliveries.mockRejectedValue(codeError("401", "INVALID_API_KEY"));
    await i.poll();
    i.lastPollTime = 0;
    i.log.error.mockClear();
    await i.poll();
    // Repeats stay at error level — unlike NETWORK, this needs user action.
    expect(i.log.error).toHaveBeenCalledWith(expect.stringContaining("Invalid API key"));
  });

  it("FORBIDDEN surfaces the premium-subscription hint", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    client.getDeliveries.mockRejectedValueOnce(codeError("403", "FORBIDDEN"));
    await i.poll();
    expect(i.log.error).toHaveBeenCalledWith(expect.stringContaining("Premium subscription"));
  });

  it("NETWORK errors warn once, demote repeats to debug, and recovery logs once", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    client.getDeliveries.mockRejectedValueOnce(codeError("refused", "ECONNREFUSED"));
    await i.poll();
    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("Cannot reach parcel.app"));
    expect(i.setStateChangedAsync).toHaveBeenCalledWith("info.connection", { val: false, ack: true });

    client.getDeliveries.mockRejectedValueOnce(codeError("refused", "ECONNREFUSED"));
    i.lastPollTime = 0;
    i.log.warn.mockClear();
    await i.poll();
    expect(i.log.warn).not.toHaveBeenCalled(); // repeat → debug

    i.lastPollTime = 0;
    await i.poll(); // success
    expect(i.log.info).toHaveBeenCalledWith("Connection restored");
    expect(i.lastErrorCode).toBe("");
  });

  it("TIMEOUT warns with the retry hint", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    client.getDeliveries.mockRejectedValueOnce(codeError("Request timeout", "ETIMEDOUT"));
    await i.poll();
    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("timeout"));
  });
});

describe("ParcelappAdapter onMessage", () => {
  it("checkConnection: rejects a too-short api key without creating a client", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    client.testConnection.mockClear();
    await i.onMessage({
      command: "checkConnection",
      from: "system.adapter.admin.0",
      callback: { id: 1 },
      message: { apiKey: "short" },
    });
    expect(client.testConnection).not.toHaveBeenCalled();
    expect(i.sendTo).toHaveBeenCalledWith(
      "system.adapter.admin.0",
      "checkConnection",
      { success: false, message: "API key is too short" },
      expect.anything(),
    );
  });

  it("checkConnection: runs the test client and reports the result", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    await i.onMessage({
      command: "checkConnection",
      from: "system.adapter.admin.0",
      callback: { id: 1 },
      message: { apiKey: "0123456789abcdef" },
    });
    expect(client.testConnection).toHaveBeenCalled();
    expect(i.sendTo).toHaveBeenCalledWith(
      "system.adapter.admin.0",
      "checkConnection",
      { success: true, message: "Connection successful" },
      expect.anything(),
    );
    expect(i.testClients.size).toBe(0); // registered + deregistered
  });

  it("addDelivery: adds and triggers a forced follow-up poll", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    client.getDeliveries.mockClear();
    await i.onMessage({
      command: "addDelivery",
      from: "system.adapter.admin.0",
      callback: { id: 1 },
      message: { tracking_number: "NEW1", carrier_code: "dhl", description: "New package" },
    });
    expect(client.addDelivery).toHaveBeenCalledWith({
      tracking_number: "NEW1",
      carrier_code: "dhl",
      description: "New package",
    });
    // The forced poll bypasses the 60s throttle.
    await new Promise(resolve => setImmediate(resolve));
    expect(client.getDeliveries).toHaveBeenCalled();
  });

  it("addDelivery: a null message yields a clear validation error (v0.7.2 hardening)", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    await i.onMessage({
      command: "addDelivery",
      from: "system.adapter.admin.0",
      callback: { id: 1 },
      message: null,
    });
    expect(client.addDelivery).not.toHaveBeenCalled();
    expect(i.sendTo).toHaveBeenCalledWith(
      "system.adapter.admin.0",
      "addDelivery",
      { success: false, error_message: "tracking_number and carrier_code are required" },
      expect.anything(),
    );
  });

  it("addDelivery: missing carrier_code yields the validation error", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    await i.onMessage({
      command: "addDelivery",
      from: "system.adapter.admin.0",
      callback: { id: 1 },
      message: { tracking_number: "NEW1" },
    });
    expect(client.addDelivery).not.toHaveBeenCalled();
  });

  it("addDelivery before init reports 'Adapter not initialized'", async () => {
    const { adapter } = setup({ apiKey: "" }); // onReady will refuse → client stays null
    const i = internalOf(adapter);
    await i.onReady();
    await i.onMessage({
      command: "addDelivery",
      from: "x",
      callback: { id: 1 },
      message: { tracking_number: "N", carrier_code: "dhl" },
    });
    expect(i.sendTo).toHaveBeenCalledWith(
      "x",
      "addDelivery",
      { success: false, error_message: "Adapter not initialized" },
      expect.anything(),
    );
  });

  it("answers unknown commands instead of leaving the callback hanging", async () => {
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    await i.onMessage({ command: "noSuchCommand", from: "x", callback: { id: 1 } });
    expect(i.sendTo).toHaveBeenCalledWith("x", "noSuchCommand", { error: "Unknown command" }, expect.anything());
  });

  it("a throwing handler reports the failure through sendTo", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    client.testConnection.mockRejectedValueOnce(new Error("boom"));
    await i.onMessage({
      command: "checkConnection",
      from: "x",
      callback: { id: 1 },
      message: { apiKey: "0123456789abcdef" },
    });
    expect(i.sendTo).toHaveBeenCalledWith(
      "x",
      "checkConnection",
      { success: false, error_message: "boom" },
      expect.anything(),
    );
    expect(i.testClients.size).toBe(0); // finally cleaned up
  });
});
