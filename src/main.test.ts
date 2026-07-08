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
    public setStateChangedAsync = vi.fn(async () => ({ id: "", notChanged: false }));
    public setState = vi.fn(async () => {});
    public setInterval = vi.fn(() => ({}) as unknown);
    public clearInterval = vi.fn();
    public sendTo = vi.fn();
    public terminate = vi.fn();
    public getObjectAsync = vi.fn(async () => null);
    public delObjectAsync = vi.fn(async () => {});
    constructor(_opts: unknown) {}
  }
  return {
    Adapter,
    EXIT_CODES: { START_IMMEDIATELY_AFTER_STOP: 156 },
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
    status_code: 2,
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
  unloaded: boolean;
  failedDeliveries: Set<string>;
  addTimestamps: number[];
  testClients: Set<{ cancelAll: () => void }>;
  pollTimer: unknown;
  config: Record<string, unknown>;
  log: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  setState: ReturnType<typeof vi.fn>;
  setStateChangedAsync: ReturnType<typeof vi.fn>;
  setInterval: ReturnType<typeof vi.fn>;
  clearInterval: ReturnType<typeof vi.fn>;
  sendTo: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  classifyError: (err: Error & { code?: string }) => string;
  onReady: () => Promise<void>;
  onUnload: (cb: () => void) => void;
  onMessage: (obj: unknown) => Promise<void>;
  poll: () => Promise<void>;
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
  // Fake mirrors the REAL StateManager contract (v0.10.0, L21): drift status
  // codes resolve to -1 (kept visible), never 0/Delivered; a missing tracking
  // number sanitizes to "unknown", never the string "undefined".
  const stateMgr: FakeStateMgr = {
    parseStatus: vi.fn((d: ParcelDelivery) => {
      const n = typeof d.status_code === "number" ? d.status_code : parseInt(String(d.status_code ?? ""), 10);
      return Number.isFinite(n) ? Math.trunc(n) : -1;
    }),
    resetPollState: vi.fn(),
    packageId: vi.fn((d: ParcelDelivery) =>
      typeof d.tracking_number === "string" && d.tracking_number.length > 0
        ? d.tracking_number.toLowerCase()
        : "unknown",
    ),
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
  // Clear the 60s gap so each test's poll() runs immediately.
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
    // v0.10.0 (I9): further transient transport codes in the NETWORK class.
    ["EPIPE", codeError("pipe", "EPIPE"), "NETWORK"],
    ["ECONNABORTED", codeError("aborted", "ECONNABORTED"), "NETWORK"],
    ["EPROTO", codeError("tls", "EPROTO"), "NETWORK"],
    ["ETIMEDOUT", codeError("slow", "ETIMEDOUT"), "TIMEOUT"],
    // v0.10.0 (M1): client-coded failures pass through as-is...
    ["TIMEOUT", codeError("Request timeout", "TIMEOUT"), "TIMEOUT"],
    ["PARSE_ERROR", codeError("JSON parse error (12 bytes)", "PARSE_ERROR"), "PARSE_ERROR"],
    ["ABORTED", codeError("Request aborted", "ABORTED"), "ABORTED"],
    // ...and a present code WINS over a "timeout" substring in the message —
    // an API error_message merely containing the word is no longer TIMEOUT.
    ["API_ERROR with timeout text", codeError("API error: connection timeout to carrier", "API_ERROR"), "API_ERROR"],
    ["timeout in message (code-less)", new Error("Request timeout"), "TIMEOUT"],
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
    // A config problem is the user's move — no restart loop out of it.
    expect(i.terminate).not.toHaveBeenCalled();
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
    expect(i.setState.mock.calls[0]).toEqual(["info.connection", { val: false, ack: true }]);
  });

  it("a failing boot step logs and requests a restart instead of idling as a zombie (L4)", async () => {
    const { adapter } = setup();
    const i = internalOf(adapter);
    i.setState.mockRejectedValueOnce(new Error("db down"));
    await i.onReady();
    expect(i.log.error).toHaveBeenCalledWith(expect.stringContaining("onReady failed: db down"));
    // v0.10.0 (L4): terminate with the restart exit code — js-controller
    // brings the instance back up, which self-heals a transient failure.
    expect(i.terminate).toHaveBeenCalledWith(expect.stringContaining("restart"), 156);
  });

  it("does not terminate when the failure happened because of an unload mid-start (L2)", async () => {
    const { adapter, client } = setup();
    const i = internalOf(adapter);
    client.getDeliveries.mockImplementationOnce(async () => {
      i.onUnload(vi.fn());
      throw codeError("Request aborted", "ABORTED");
    });
    await i.onReady();
    expect(i.terminate).not.toHaveBeenCalled();
  });

  it("a stop during the first poll does not arm the timer afterwards (L2)", async () => {
    const { adapter, client } = setup();
    const i = internalOf(adapter);
    client.getDeliveries.mockImplementationOnce(async () => {
      // Unload arrives while the first poll is in flight.
      i.onUnload(vi.fn());
      return [];
    });
    await i.onReady();
    expect(i.setInterval).not.toHaveBeenCalled();
    expect(i.log.info).not.toHaveBeenCalledWith(expect.stringContaining("Parcel tracking started"));
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

  it("a failing cleanupObsoleteStates does not abort startup — polling still arms (C8)", async () => {
    const { adapter, client } = setup();
    const i = internalOf(adapter);
    (adapter as unknown as { getObjectAsync: ReturnType<typeof vi.fn> }).getObjectAsync.mockRejectedValueOnce(
      new Error("db down"),
    );
    await i.onReady();
    // C8: the cleanup failure is contained, so the poll interval is still armed.
    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("cleanupObsoleteStates failed"));
    expect(client.getDeliveries).toHaveBeenCalled();
    expect(i.setInterval).toHaveBeenCalledTimes(1);
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
    expect(i.unloaded).toBe(true);
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
  it("skips overlapping polls (in-flight guard) and leaves a debug trace (M4)", async () => {
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
    // v0.10.0 (M4): the skip is no longer silent.
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("already running"));
    release([]);
    await first;
  });

  it("throttles polls within the 60s gap (no force bypass anymore, L5)", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    await i.poll(); // sets lastPollTime = now
    client.getDeliveries.mockClear();

    await i.poll(); // within 60s → skipped
    expect(client.getDeliveries).not.toHaveBeenCalled();
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("too soon after last poll"));
  });

  it("the rate-limit cooldown blocks polls", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    i.rateLimitedUntil = Date.now() + 60_000;
    client.getDeliveries.mockClear();
    await i.poll();
    expect(client.getDeliveries).not.toHaveBeenCalled();
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("rate limited"));
  });
});

describe("ParcelappAdapter poll — happy path", () => {
  it("updates every delivery, cleans up and refreshes the summary", async () => {
    const { adapter, client, stateMgr } = await setupReady();
    const i = internalOf(adapter);
    const a = makeDelivery({ tracking_number: "A", status_code: 2 });
    const b = makeDelivery({ tracking_number: "B", status_code: 4 });
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
    const active = makeDelivery({ tracking_number: "A", status_code: 2 });
    const delivered = makeDelivery({ tracking_number: "D", status_code: 0 });
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
    const active = makeDelivery({ tracking_number: "A", status_code: 2 });
    const delivered = makeDelivery({ tracking_number: "D", status_code: 0 });
    client.getDeliveries.mockResolvedValue([active, delivered]);
    stateMgr.updateDelivery.mockClear();

    await i.poll();

    expect(client.getDeliveries).toHaveBeenLastCalledWith("recent");
    expect(stateMgr.updateDelivery).toHaveBeenCalledTimes(2); // delivered stays visible
    expect(stateMgr.updateSummary).toHaveBeenCalledWith([active]); // summary still active-only
  });

  it("pairs every delivery with its pre-pass pkgId across update batches (M10, 30 deliveries)", async () => {
    const { adapter, client, stateMgr } = await setupReady();
    const i = internalOf(adapter);
    const deliveries = Array.from({ length: 30 }, (_, n) =>
      makeDelivery({ tracking_number: `BULK${String(n).padStart(2, "0")}`, status_code: 2 }),
    );
    client.getDeliveries.mockResolvedValue(deliveries);
    stateMgr.updateDelivery.mockClear();
    stateMgr.cleanupDeliveries.mockClear();

    await i.poll();

    // 30 > UPDATE_BATCH_SIZE (25) → two batches, announced in the debug log.
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("batches of 25"));
    expect(stateMgr.updateDelivery).toHaveBeenCalledTimes(30);
    // The only index arithmetic in the poll path is pkgIds[start + offset] —
    // every call must carry ITS OWN delivery paired with ITS OWN pkgId.
    for (const call of stateMgr.updateDelivery.mock.calls as [ParcelDelivery, string, string][]) {
      expect(call[2], `pkgId pairing for ${call[0].tracking_number}`).toBe(String(call[0].tracking_number).toLowerCase());
    }
    // The keep-set contains ALL 30 ids — nothing dropped by the batching.
    const keepSet = stateMgr.cleanupDeliveries.mock.calls[0][0] as string[];
    expect(keepSet).toHaveLength(30);
    expect(new Set(keepSet).size).toBe(30);
  });
});

describe("ParcelappAdapter poll — per-delivery failure dedup", () => {
  it("warns on the first failure, demotes repeats to debug, clears on success", async () => {
    const { adapter, stateMgr } = await setupReady();
    const i = internalOf(adapter);
    stateMgr.updateDelivery.mockRejectedValue(new Error("redis hiccup"));

    await i.poll();
    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to update 'TRK1'"));
    expect(i.failedDeliveries.has("trk1")).toBe(true);

    i.lastPollTime = 0;
    i.log.warn.mockClear();
    await i.poll();
    expect(i.log.warn).not.toHaveBeenCalled(); // repeat → debug

    stateMgr.updateDelivery.mockResolvedValue(undefined);
    i.lastPollTime = 0;
    await i.poll();
    expect(i.failedDeliveries.has("trk1")).toBe(false);
  });

  it("keeps a write-failed but still-present delivery in the cleanup keep-set", async () => {
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
    // The keep-set is EVERY package the API still returns this poll — including
    // 'bad', whose updateDelivery threw. The old code passed only the writes
    // that succeeded (['ok']), so 'bad' got deleted on the next prune (silent
    // data loss). cleanupDeliveries itself (real-StateManager tests) then keeps
    // exactly these and removes the rest.
    expect(stateMgr.cleanupDeliveries).toHaveBeenCalledWith(["ok", "bad"]);
  });

  it("polls cleanly when the API drops optional fields (no tracking_number/carrier_code)", async () => {
    const { adapter, client, stateMgr } = await setupReady();
    const i = internalOf(adapter);
    const partial = makeDelivery({ tracking_number: undefined, carrier_code: undefined });
    client.getDeliveries.mockResolvedValue([partial]);

    // The optional-field guards (`?? ""`) must keep the poll from throwing.
    await expect(i.poll()).resolves.toBeUndefined();
    expect(stateMgr.updateDelivery).toHaveBeenCalled();
  });

  it("prunes failedDeliveries entries for trackings that vanished from the API", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    i.failedDeliveries.add("GONE");
    client.getDeliveries.mockResolvedValue([makeDelivery({ tracking_number: "TRK1" })]);
    await i.poll();
    expect(i.failedDeliveries.has("GONE")).toBe(false);
  });

  it("broker failures in cleanup/summary warn but keep info.connection green (M2)", async () => {
    const { adapter, stateMgr } = await setupReady();
    const i = internalOf(adapter);
    stateMgr.cleanupDeliveries.mockRejectedValueOnce(new Error("db down"));
    i.setStateChangedAsync.mockClear();

    await i.poll();

    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("State maintenance failed"));
    // The API call succeeded — connection stays true, no false write follows.
    expect(i.setStateChangedAsync).toHaveBeenCalledWith("info.connection", { val: true, ack: true });
    expect(i.setStateChangedAsync).not.toHaveBeenCalledWith("info.connection", { val: false, ack: true });
    // And the failure does not poison the API error dedup state.
    expect(i.lastErrorCode).toBe("");
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

  it("a persistent 429 warns once and demotes repeats to debug (M3)", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    client.getDeliveries.mockRejectedValue(codeError("429", "RATE_LIMITED", { retryAfterSeconds: 60 }));
    await i.poll();
    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("Rate limit hit"));

    i.lastPollTime = 0;
    i.rateLimitedUntil = 0; // cooldown elapsed, next attempt hits 429 again
    i.log.warn.mockClear();
    await i.poll();
    expect(i.log.warn).not.toHaveBeenCalled(); // repeat → debug
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("Rate limit hit"));
  });

  it("a successful poll clears the rate-limit cooldown", async () => {
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    i.rateLimitedUntil = Date.now() - 1; // expired cooldown from a previous 429
    await i.poll();
    expect(i.rateLimitedUntil).toBe(0);
  });

  it("INVALID_API_KEY logs one error, repeats demote to debug (M3)", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    client.getDeliveries.mockRejectedValue(codeError("401", "INVALID_API_KEY"));
    await i.poll();
    expect(i.log.error).toHaveBeenCalledWith(expect.stringContaining("Invalid API key"));

    i.lastPollTime = 0;
    i.log.error.mockClear();
    await i.poll();
    // v0.10.0 (M3): no more 144 identical error lines/day — repeats at debug.
    expect(i.log.error).not.toHaveBeenCalled();
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("Invalid API key"));
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
    client.getDeliveries.mockRejectedValueOnce(codeError("Request timeout", "TIMEOUT"));
    await i.poll();
    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("timeout"));
  });

  it("a shutdown abort routes to debug — no red error line on a deliberate stop (M1)", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    client.getDeliveries.mockRejectedValueOnce(codeError("Request aborted", "ABORTED"));
    await i.poll();
    expect(i.log.error).not.toHaveBeenCalled();
    expect(i.log.warn).not.toHaveBeenCalledWith(expect.stringContaining("aborted"));
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("Poll aborted"));
  });
});

describe("ParcelappAdapter onMessage", () => {
  it("checkConnection: rejects a too-short api key with the admin {error} envelope (H1)", async () => {
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
      { error: "API key is too short" },
      expect.anything(),
    );
  });

  it("checkConnection: success maps to {result} — the shape ConfigSendto actually reads (H1)", async () => {
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
      { result: "Connection successful" },
      expect.anything(),
    );
    expect(i.testClients.size).toBe(0); // registered + deregistered
  });

  it("checkConnection: a failed test maps to {error} — no more false-positive 'Ok' (H1)", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    client.testConnection.mockResolvedValueOnce({ success: false, message: "Invalid API key" });
    await i.onMessage({
      command: "checkConnection",
      from: "system.adapter.admin.0",
      callback: { id: 1 },
      message: { apiKey: "0123456789abcdef" },
    });
    expect(i.sendTo).toHaveBeenCalledWith(
      "system.adapter.admin.0",
      "checkConnection",
      { error: "Invalid API key" },
      expect.anything(),
    );
  });

  it("addDelivery: adds and triggers an immediate follow-up poll (gap already elapsed)", async () => {
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
    await new Promise(resolve => setImmediate(resolve));
    expect(client.getDeliveries).toHaveBeenCalled();
  });

  it("addDelivery: the follow-up poll respects the 60s gap — bursts cannot stack GETs (L5)", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    i.lastPollTime = Date.now(); // a poll just ran
    client.getDeliveries.mockClear();
    await i.onMessage({
      command: "addDelivery",
      from: "system.adapter.admin.0",
      callback: { id: 1 },
      message: { tracking_number: "NEW1B", carrier_code: "dhl", description: "New package" },
    });
    await new Promise(resolve => setImmediate(resolve));
    // The add itself succeeded, but no extra GET was burned within the gap.
    expect(client.addDelivery).toHaveBeenCalled();
    expect(client.getDeliveries).not.toHaveBeenCalled();
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("too soon after last poll"));
  });

  it("addDelivery: passes language and send_push_confirmation through when provided", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    await i.onMessage({
      command: "addDelivery",
      from: "system.adapter.admin.0",
      callback: { id: 1 },
      message: {
        tracking_number: "NEW2",
        carrier_code: "dhl",
        description: "Parcel",
        language: "de",
        send_push_confirmation: true,
      },
    });
    expect(client.addDelivery).toHaveBeenCalledWith({
      tracking_number: "NEW2",
      carrier_code: "dhl",
      description: "Parcel",
      language: "de",
      send_push_confirmation: true,
    });
  });

  it("addDelivery: a drifted success string ('false') does not trigger the follow-up poll (L9)", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    client.addDelivery.mockResolvedValueOnce({ success: "false" });
    client.getDeliveries.mockClear();
    await i.onMessage({
      command: "addDelivery",
      from: "system.adapter.admin.0",
      callback: { id: 1 },
      message: { tracking_number: "DRIFT1", carrier_code: "dhl", description: "x" },
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(client.getDeliveries).not.toHaveBeenCalled();
  });

  it("addDelivery: missing description yields the validation error", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    await i.onMessage({
      command: "addDelivery",
      from: "system.adapter.admin.0",
      callback: { id: 1 },
      message: { tracking_number: "NEW3", carrier_code: "dhl" },
    });
    expect(client.addDelivery).not.toHaveBeenCalled();
    expect(i.sendTo).toHaveBeenCalledWith(
      "system.adapter.admin.0",
      "addDelivery",
      { success: false, error_message: "tracking_number, carrier_code and description are required" },
      expect.anything(),
    );
  });

  it("addDelivery: an over-long description yields the length validation error", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    await i.onMessage({
      command: "addDelivery",
      from: "system.adapter.admin.0",
      callback: { id: 1 },
      message: { tracking_number: "NEW4", carrier_code: "dhl", description: "x".repeat(513) },
    });
    expect(client.addDelivery).not.toHaveBeenCalled();
    expect(i.sendTo).toHaveBeenCalledWith(
      "system.adapter.admin.0",
      "addDelivery",
      { success: false, error_message: "each field must be at most 512 characters" },
      expect.anything(),
    );
  });

  it("addDelivery: an over-long optional language field is capped too (L24)", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    await i.onMessage({
      command: "addDelivery",
      from: "system.adapter.admin.0",
      callback: { id: 1 },
      message: { tracking_number: "NEW5", carrier_code: "dhl", description: "ok", language: "x".repeat(513) },
    });
    expect(client.addDelivery).not.toHaveBeenCalled();
    expect(i.sendTo).toHaveBeenCalledWith(
      "system.adapter.admin.0",
      "addDelivery",
      { success: false, error_message: "each field must be at most 512 characters" },
      expect.anything(),
    );
  });

  it("addDelivery: throttles a burst beyond the per-window limit (S4)", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    const add = (n: number): Promise<void> =>
      i.onMessage({
        command: "addDelivery",
        from: "system.adapter.admin.0",
        callback: { id: n },
        message: { tracking_number: `T${n}`, carrier_code: "dhl", description: "x" },
      });

    // The first 20 (MAX_ADDS_PER_WINDOW) go through within the same window...
    for (let n = 0; n < 20; n++) {
      await add(n);
    }
    expect(client.addDelivery).toHaveBeenCalledTimes(20);

    // ...the 21st is throttled — not sent to the API, clear error back.
    i.sendTo.mockClear();
    await add(99);
    expect(client.addDelivery).toHaveBeenCalledTimes(20);
    expect(i.sendTo).toHaveBeenCalledWith(
      "system.adapter.admin.0",
      "addDelivery",
      expect.objectContaining({ success: false, error_message: expect.stringContaining("too many") }),
      expect.anything(),
    );
  });

  it("addDelivery: the throttle window expires — a request goes through again after 60s (L25)", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    // Simulate 20 adds that happened 61s ago: a sign/comparison bug in the
    // window filter would keep the throttle closed forever.
    i.addTimestamps = Array.from({ length: 20 }, () => Date.now() - 61_000);
    client.addDelivery.mockClear();
    await i.onMessage({
      command: "addDelivery",
      from: "system.adapter.admin.0",
      callback: { id: 1 },
      message: { tracking_number: "AFTER_WINDOW", carrier_code: "dhl", description: "x" },
    });
    expect(client.addDelivery).toHaveBeenCalledTimes(1);
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
      { success: false, error_message: "tracking_number, carrier_code and description are required" },
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

  it("a throwing checkConnection handler reports via the admin {error} envelope (H1)", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    client.testConnection.mockRejectedValueOnce(new Error("boom"));
    await i.onMessage({
      command: "checkConnection",
      from: "x",
      callback: { id: 1 },
      message: { apiKey: "0123456789abcdef" },
    });
    expect(i.sendTo).toHaveBeenCalledWith("x", "checkConnection", { error: "boom" }, expect.anything());
    expect(i.testClients.size).toBe(0); // finally cleaned up
  });

  it("a throwing addDelivery handler keeps the documented script envelope", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    client.addDelivery.mockRejectedValueOnce(new Error("boom"));
    await i.onMessage({
      command: "addDelivery",
      from: "x",
      callback: { id: 1 },
      message: { tracking_number: "N1", carrier_code: "dhl", description: "d" },
    });
    expect(i.sendTo).toHaveBeenCalledWith(
      "x",
      "addDelivery",
      { success: false, error_message: "boom" },
      expect.anything(),
    );
  });
});
