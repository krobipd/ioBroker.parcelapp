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
    public setStateChangedAsync = vi.fn(() => Promise.resolve({ id: "", notChanged: false }));
    public setState = vi.fn(async () => {});
    public setInterval = vi.fn(() => ({}));
    public clearInterval = vi.fn();
    public sendTo = vi.fn();
    public terminate = vi.fn();
    public getObjectAsync = vi.fn(() => Promise.resolve(null));
    public delObjectAsync = vi.fn(async () => {});
    // Objects below this instance's namespace, written by refreshManifestObjects.
    public objects = new Map<string, { type?: string; common?: Record<string, unknown> }>();
    public extendObject = vi.fn((id: string, obj: { type?: string; common?: Record<string, unknown> }) => {
      const existing = this.objects.get(id);
      this.objects.set(id, {
        type: obj.type ?? existing?.type,
        common: { ...(existing?.common ?? {}), ...(obj.common ?? {}) },
      });
      return Promise.resolve();
    });
    // Instance object of this very instance — the self-correction reads and rewrites it.
    // Default: no supportedMessages and no obsolete native keys (a clean install).
    public instanceObject: { common?: Record<string, unknown>; native?: Record<string, unknown> } | null = {
      common: {},
      native: { apiKey: "encrypted", pollInterval: 10, autoRemoveDelivered: true },
    };
    public getForeignObjectAsync = vi.fn(() => Promise.resolve(this.instanceObject));
    // setForeignObject, not extendObject: the deep merge behind extendObject SETS a key given
    // as null instead of dropping it, so removing an obsolete native key needs a full write.
    public setForeignObject = vi.fn(
      (_id: string, obj: { common?: Record<string, unknown>; native?: Record<string, unknown> }) => {
        this.instanceObject = obj;
        return Promise.resolve();
      },
    );
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

/**
 * Typed access to the private fields/methods the orchestration tests drive.
 *
 * @param adapter Adapter instance under test
 */
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
  instanceObject: { common?: Record<string, unknown>; native?: Record<string, unknown> } | null;
  getForeignObjectAsync: ReturnType<typeof vi.fn>;
  setForeignObject: ReturnType<typeof vi.fn>;
  extendObject: ReturnType<typeof vi.fn>;
  objects: Map<string, { type?: string; common?: Record<string, unknown> }>;
  onReady: () => Promise<void>;
  onUnload: (cb: () => void) => void;
  onMessage: (obj: unknown) => Promise<void>;
  poll: () => Promise<void>;
} {
  return adapter as unknown as ReturnType<typeof internalOf>;
}

/**
 * Build an adapter with fake client/stateManager factories + valid config.
 *
 * @param configOverrides Instance settings that replace the valid defaults
 */
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
    getDeliveries: vi.fn(() => Promise.resolve([makeDelivery()])),
    getCarrierName: vi.fn(() => Promise.resolve("DHL")),
    addDelivery: vi.fn(() => Promise.resolve({ success: true })),
    testConnection: vi.fn(() => Promise.resolve({ success: true, message: "Connection successful" })),
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

/**
 * setup() + onReady() so client/stateManager are wired like in production.
 *
 * @param configOverrides Instance settings that replace the valid defaults
 */
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

describe("ParcelappAdapter default factories (the seams' production side)", () => {
  it("builds a real client and state manager when no test seam replaces them", () => {
    // Every other test injects fakes here, so the production factories — the
    // ONLY place the adapter wires up its real client — had no coverage at all.
    // The factories are called DIRECTLY: driving them through onReady would fire
    // a real request at api.parcel.app, which no unit test may ever do.
    const adapter = new ParcelappAdapter();
    const i = internalOf(adapter) as unknown as {
      makeClient: (apiKey: string) => Record<string, unknown>;
      makeStateManager: () => Record<string, unknown>;
      log: { debug: ReturnType<typeof vi.fn> };
    };

    const client = i.makeClient("0123456789abcdef");
    // The real client carries the five members main.ts declares it needs.
    for (const member of ["getDeliveries", "getCarrierName", "addDelivery", "testConnection", "cancelAll"]) {
      expect(typeof client[member], member).toBe("function");
    }
    // cancelAll on a fresh client is a no-op that must not throw, and it proves
    // the debug logger handed to the client really reaches the adapter log.
    expect(() => (client.cancelAll as () => void)()).not.toThrow();
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("cancelAll"));

    const stateManager = i.makeStateManager();
    for (const member of ["resetPollState", "packageId", "parseStatus", "updateDelivery", "updateSummary"]) {
      expect(typeof stateManager[member], member).toBe("function");
    }
  });
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
    const { adapter } = setup();
    const i = internalOf(adapter);
    // A rejected getDeliveries never reaches onReady's catch (poll handles it
    // itself), so make the start step itself fail AFTER the unload arrived —
    // that is the only way into the `if (!this.unloaded)` guard around terminate.
    // Mutation-checked 2026-09-02 (P8): guard removed → terminate called → red.
    vi.spyOn(i, "poll").mockImplementationOnce(() => {
      i.onUnload(vi.fn());
      return Promise.reject(new Error("host is gone"));
    });
    await i.onReady();
    expect(i.log.error).toHaveBeenCalledWith(expect.stringContaining("onReady failed"));
    expect(i.terminate).not.toHaveBeenCalled();
  });

  it("a stop during the first poll does not arm the timer afterwards (L2)", async () => {
    const { adapter, client } = setup();
    const i = internalOf(adapter);
    client.getDeliveries.mockImplementationOnce(() => {
      // Unload arrives while the first poll is in flight.
      i.onUnload(vi.fn());
      return Promise.resolve([]);
    });
    await i.onReady();
    expect(i.setInterval).not.toHaveBeenCalled();
    expect(i.log.info).not.toHaveBeenCalledWith(expect.stringContaining("Parcel tracking started"));
  });

  it("the armed interval actually polls — the adapter's recurring work (C10)", async () => {
    // Until 2026-08-22 nothing drove this callback: emptying it left all tests
    // green while the adapter would have polled ONCE at startup and then never
    // again, still logging "polling every 10 minutes". The interval callback is
    // the only place that recurring poll lives.
    const { adapter, client } = setup();
    const i = internalOf(adapter);
    await i.onReady();
    const scheduled = i.setInterval.mock.calls[0][0] as () => void;
    expect(typeof scheduled).toBe("function");
    // Argument two is the resolved interval in milliseconds.
    expect(i.setInterval.mock.calls[0][1]).toBe(10 * 60 * 1000);

    client.getDeliveries.mockClear();
    i.lastPollTime = 0; // the 60s gap has elapsed
    scheduled();
    await new Promise(resolve => setImmediate(resolve));
    expect(client.getDeliveries).toHaveBeenCalledTimes(1);
  });

  it("a failing scheduled poll is caught and logged, never left unhandled", async () => {
    // The callback is fire-and-forget: without its .catch a rejected poll would
    // surface as an unhandled rejection and (js-controller ≥7) can kill the
    // process. handlePollError swallows client errors, so the rejection has to
    // come from the layer below it.
    const { adapter, client } = setup();
    const i = internalOf(adapter);
    await i.onReady();
    const scheduled = i.setInterval.mock.calls[0][0] as () => void;
    i.lastPollTime = 0;
    // poll() catches everything the API can do to it, so the rejection has to
    // come from the error handling itself. A failure whose `code` cannot even
    // be read stands in for "something in handlePollError went wrong".
    const hostile = new Error("unreadable");
    Object.defineProperty(hostile, "code", {
      get() {
        throw new Error("broker exploded");
      },
    });
    client.getDeliveries.mockRejectedValueOnce(hostile);
    expect(() => scheduled()).not.toThrow();
    await new Promise(resolve => setImmediate(resolve));
    expect(i.log.error).toHaveBeenCalledWith(expect.stringContaining("Scheduled poll failed"));
  });

  it("clamps the configured poll interval into [5, 60] minutes and defaults sanely (C13)", async () => {
    // Only the pass-through case (10) was covered; the bounds that stop a
    // 1-minute hammer or a NaN-fed setInterval were not.
    const cases: [unknown, number][] = [
      [1, 5], // below minimum → clamped up
      [5, 5],
      [60, 60],
      [999, 60], // above maximum → clamped down
      ["15", 15], // admin may hand over a string
      ["abc", 10], // unparseable → default
      [undefined, 10],
      [null, 10],
      [12.9, 12], // floored, not rounded
    ];
    for (const [raw, expectedMinutes] of cases) {
      const { adapter } = setup({ pollInterval: raw });
      const i = internalOf(adapter);
      await i.onReady();
      expect(i.setInterval.mock.calls[0][1], `pollInterval=${JSON.stringify(raw)}`).toBe(expectedMinutes * 60 * 1000);
      expect(i.log.info).toHaveBeenCalledWith(expect.stringContaining(`every ${expectedMinutes} minutes`));
    }
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
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
  });

  it("reports done only after the disconnect write landed", async () => {
    // Calling back first lets the host tear the process down mid-write, and the
    // instance keeps claiming a live connection until someone starts it again.
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    let releaseWrite = (): void => {};
    i.setState.mockImplementationOnce(() => new Promise<void>(resolve => (releaseWrite = resolve)));
    const callback = vi.fn();

    i.onUnload(callback);
    await new Promise(resolve => setImmediate(resolve));
    expect(callback).not.toHaveBeenCalled();

    releaseWrite();
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
  });

  it("still calls back when cleanup throws", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    client.cancelAll.mockImplementation(() => {
      throw new Error("already closed");
    });
    const callback = vi.fn();
    i.onUnload(callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("onUnload error"));
  });

  it("reports the instance as disconnected on the way out", async () => {
    // The red/green dot in the admin instance list has to go grey on a stop —
    // otherwise a stopped instance keeps claiming a live connection.
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    i.setState.mockClear();
    i.onUnload(vi.fn());
    expect(i.setState).toHaveBeenCalledWith("info.connection", { val: false, ack: true });
  });

  it("survives a broker that is already gone while writing the disconnect", async () => {
    // The fire-and-forget write must not surface as an unhandled rejection
    // during shutdown, and the callback still has to run exactly once.
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    i.setState.mockRejectedValueOnce(new Error("broker down"));
    const callback = vi.fn();
    expect(() => i.onUnload(callback)).not.toThrow();
    await new Promise(resolve => setImmediate(resolve));
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

/**
 * Verbatim copy of `isMessageboxSupported` from
 * `@iobroker/js-controller-adapter/lib/adapter/utils.js` (read at js-controller 7.2.3). The
 * adapter runs this against its OWN instance object at start and only calls `subscribeMessage`
 * when it returns true — so this is the gate that decides whether onMessage ever fires.
 *
 * @param common The instance object's `common` section
 * @returns whether js-controller would subscribe this instance to messages
 */
function isMessageboxSupported(common: Record<string, unknown>): boolean {
  const supported = common.supportedMessages;
  if (supported === null || typeof supported !== "object" || Array.isArray(supported)) {
    return !!common.messagebox;
  }
  return Object.values(supported).find(val => val !== false) !== undefined;
}

describe("io-package manifest", () => {
  /**
   * The manifest must not carry `supportedMessages` AT ALL — not just `stopInstance`. Any object
   * there overrides `common.messagebox` (see isMessageboxSupported above): an empty object or a
   * second `false` entry closes the message box just as effectively, and a `true` entry brings
   * back the hard kill that leaves onUnload dead. parcelapp needs neither — it has no
   * deviceManager, and its message handler rides on plain `messagebox: true`.
   */
  it("declares no supportedMessages, so messagebox governs the message box", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const manifest = require("../io-package.json") as { common: Record<string, unknown> };
    expect(manifest.common).not.toHaveProperty("supportedMessages");
    expect(manifest.common.messagebox).toBe(true);
    expect(isMessageboxSupported(manifest.common)).toBe(true);
  });
});

describe("ParcelappAdapter instance-object self-correction", () => {
  it("REMOVES the leftover supportedMessages and aborts the start (the host restarts us)", async () => {
    // With stopInstance set the host kills the process a second after asking it to stop, so
    // onUnload never runs. An upgrade does NOT remove the key from the instance object — the
    // adapter has to correct it itself, then stand down.
    const { adapter, client } = setup();
    const i = internalOf(adapter);
    i.instanceObject = { common: { supportedMessages: { stopInstance: true } }, native: {} };

    await i.onReady();

    expect(i.setForeignObject).toHaveBeenCalledTimes(1);
    expect(i.setForeignObject.mock.calls[0][0]).toBe("system.adapter.parcelapp.0");
    expect(i.instanceObject?.common).not.toHaveProperty("supportedMessages");
    expect(client.getDeliveries).not.toHaveBeenCalled();
    expect(i.setInterval).not.toHaveBeenCalled();
    expect(i.log.info).toHaveBeenCalledWith(expect.stringContaining("restarts once"));
  });

  /**
   * The regression this guards against was shipped in v0.10.3 and lived until v0.10.4: the
   * correction SET `supportedMessages` to `{stopInstance: false}` instead of removing it.
   * `isMessageboxSupported()` in the adapter package stops reading `common.messagebox` as soon as
   * `supportedMessages` is an object and then only accepts a value that is not false — so
   * `{stopInstance: false}` closes the message box, `subscribeMessage` never runs, and both the
   * admin's Test-Connection button and every sendTo from a script die without a log line.
   */
  it("never leaves supportedMessages behind as an object — that closes the message box", async () => {
    const { adapter } = setup();
    const i = internalOf(adapter);
    i.instanceObject = { common: { messagebox: true, supportedMessages: { stopInstance: false } }, native: {} };

    await i.onReady();

    expect(i.setForeignObject).toHaveBeenCalledTimes(1);
    const common = i.instanceObject.common!;
    expect(common).not.toHaveProperty("supportedMessages");
    // Mirror the real gate: with the key gone, messagebox decides again and the box is open.
    expect(isMessageboxSupported(common)).toBe(true);
  });

  it("removes obsolete native keys, keeps the rest, and aborts the start", async () => {
    // filterMode (gone in v0.2.0) and language (gone before v0.5.0) survive in every
    // installation old enough to have them: js-controller merges the manifest in and never
    // removes a key. apiKey is encrypted and must ride along untouched.
    const { adapter, client } = setup();
    const i = internalOf(adapter);
    i.instanceObject = {
      common: {},
      native: {
        apiKey: "encrypted-secret",
        pollInterval: 25,
        filterMode: "active",
        language: "de",
        autoRemoveDelivered: false,
      },
    };

    await i.onReady();

    expect(i.setForeignObject).toHaveBeenCalledTimes(1);
    expect(i.instanceObject?.native).toEqual({
      apiKey: "encrypted-secret",
      pollInterval: 25,
      autoRemoveDelivered: false,
    });
    expect(client.getDeliveries).not.toHaveBeenCalled();
    expect(i.setInterval).not.toHaveBeenCalled();
  });

  it("corrects both leftovers in ONE write — two writes would mean two restarts", async () => {
    const { adapter } = setup();
    const i = internalOf(adapter);
    i.instanceObject = {
      common: { supportedMessages: { stopInstance: true } },
      native: { apiKey: "k", filterMode: "active", language: "de" },
    };

    await i.onReady();

    expect(i.setForeignObject).toHaveBeenCalledTimes(1);
    expect(i.instanceObject?.common).not.toHaveProperty("supportedMessages");
    expect(i.instanceObject?.native).toEqual({ apiKey: "k" });
  });

  it("leaves a healthy instance object alone and starts normally", async () => {
    const { adapter, client } = setup();
    const i = internalOf(adapter);
    i.instanceObject = { common: { name: "parcelapp" }, native: { apiKey: "k", pollInterval: 10 } };

    await i.onReady();

    expect(i.setForeignObject).not.toHaveBeenCalled();
    expect(client.getDeliveries).toHaveBeenCalledTimes(1);
    expect(i.setInterval).toHaveBeenCalledTimes(1);
  });

  it("starts normally when the instance object comes back empty", async () => {
    // getForeignObject resolving null (rather than throwing) is its own path — there is
    // nothing to correct and nothing to write, and the start must simply continue.
    const { adapter, client } = setup();
    const i = internalOf(adapter);
    i.instanceObject = null;

    await i.onReady();

    expect(i.setForeignObject).not.toHaveBeenCalled();
    expect(client.getDeliveries).toHaveBeenCalledTimes(1);
    expect(i.setInterval).toHaveBeenCalledTimes(1);
  });

  it("starts normally when the instance object cannot be read", async () => {
    // A broker hiccup at startup must not stop the adapter from polling — the
    // next start retries the correction.
    const { adapter, client } = setup();
    const i = internalOf(adapter);
    i.getForeignObjectAsync.mockRejectedValueOnce(new Error("objects db down"));

    await i.onReady();

    expect(client.getDeliveries).toHaveBeenCalledTimes(1);
    expect(i.setInterval).toHaveBeenCalledTimes(1);
  });
});

/**
 * v0.11.0. js-controller creates `io-package.json:instanceObjects` only where they are MISSING,
 * so a changed name or description otherwise reaches fresh installs only. Measured on a live
 * install: `info` and `info.connection` still carried their plain-English pre-i18n names while
 * the manifest, the linter, the type check and the name gate were all green. Only an explicit
 * refresh in onReady closes that, and only a test that watches for the call can keep it.
 */
describe("ParcelappAdapter manifest objects reach an existing installation", () => {
  it("refreshes all four manifest objects on every start", async () => {
    const { adapter } = await setupReady();
    const i = internalOf(adapter);

    expect([...i.objects.keys()].sort()).toEqual(["deliveries", "info", "info.connection", "summary"]);
  });

  it("gives info.connection its full common — name, description, type and role", async () => {
    const { adapter } = await setupReady();
    const i = internalOf(adapter);

    const common = i.objects.get("info.connection")!.common!;
    // The I18n mock echoes the key, so this also pins WHICH translation key is used.
    expect(common.name).toEqual({ en: "infoConnection" });
    expect(common.desc).toEqual({ en: "descInfoConnection" });
    expect(common.type).toBe("boolean");
    expect(common.role).toBe("indicator.connected");
    expect(common.read).toBe(true);
    expect(common.write).toBe(false);
  });

  it("leaves desc unset on the containers — a folder called Deliveries explains itself", async () => {
    const { adapter } = await setupReady();
    const i = internalOf(adapter);

    for (const id of ["info", "deliveries", "summary"]) {
      expect(i.objects.get(id)!.common!.desc, `${id} must not carry an invented description`).toBeUndefined();
      expect(i.objects.get(id)!.common!.name, `${id} needs a name`).toBeDefined();
    }
  });

  it("keeps starting when the refresh fails — a broker hiccup must not abort the start", async () => {
    const { adapter, client } = setup();
    const i = internalOf(adapter);
    i.extendObject.mockRejectedValueOnce(new Error("objects db down"));

    await i.onReady();

    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("Refreshing the manifest objects failed"));
    expect(client.getDeliveries).toHaveBeenCalledTimes(1);
    expect(i.setInterval).toHaveBeenCalledTimes(1);
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
      expect(call[2], `pkgId pairing for ${call[0].tracking_number}`).toBe(
        String(call[0].tracking_number).toLowerCase(),
      );
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
    stateMgr.updateDelivery.mockImplementation((d: ParcelDelivery) => {
      if (d.tracking_number === "BAD") {
        return Promise.reject(new Error("boom"));
      }
      return Promise.resolve();
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

  it("a broker failure on the connection=true write is not an API failure — warn, keep polling, no red line (2026-09-02)", async () => {
    // The GET succeeded; only the broker hiccuped while acknowledging it. Before
    // the fence this went through handlePollError: "Poll failed" at error level,
    // info.connection flipped to false and the dedup remembered a bogus code.
    const { adapter, stateMgr } = await setupReady();
    const i = internalOf(adapter);
    stateMgr.updateDelivery.mockClear();
    i.log.error.mockClear();
    i.setStateChangedAsync.mockRejectedValueOnce(new Error("db hiccup"));

    await i.poll();

    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("State maintenance failed"));
    expect(i.log.error).not.toHaveBeenCalled();
    expect(i.lastErrorCode).toBe("");
    // The poll went on: deliveries were still written after the failed acknowledge.
    expect(stateMgr.updateDelivery).toHaveBeenCalled();
    expect(i.setStateChangedAsync).not.toHaveBeenCalledWith("info.connection", { val: false, ack: true });
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

  it("RATE_LIMITED clamps a tiny retry-after UP to the 60 s floor (never a cooldown of a few seconds)", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    client.getDeliveries.mockRejectedValueOnce(codeError("429", "RATE_LIMITED", { retryAfterSeconds: 5 }));
    await i.poll();
    expect(i.rateLimitedUntil).toBeGreaterThanOrEqual(Date.now() + 59_000);
    expect(i.rateLimitedUntil).toBeLessThanOrEqual(Date.now() + 61_000);
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

  it("FORBIDDEN repeats demote to debug — not 144 identical error lines a day (M3)", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    client.getDeliveries.mockRejectedValue(codeError("403", "FORBIDDEN"));
    await i.poll();
    expect(i.log.error).toHaveBeenCalledWith(expect.stringContaining("Premium subscription"));

    i.lastPollTime = 0;
    i.log.error.mockClear();
    await i.poll();
    expect(i.log.error).not.toHaveBeenCalled();
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("Premium subscription"));
  });

  it("TIMEOUT repeats demote to debug as well", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    client.getDeliveries.mockRejectedValue(codeError("Request timeout", "TIMEOUT"));
    await i.poll();
    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("timeout"));

    i.lastPollTime = 0;
    i.log.warn.mockClear();
    await i.poll();
    expect(i.log.warn).not.toHaveBeenCalled();
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("Poll failed (ongoing)"));
  });

  it("an unclassified failure errors once, then repeats at debug (default branch)", async () => {
    // Everything without a known code — e.g. a PARSE_ERROR from the client or a
    // foreign error — takes the default branch, which had no coverage at all.
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    client.getDeliveries.mockRejectedValue(codeError("JSON parse error (12 bytes)", "PARSE_ERROR"));
    await i.poll();
    expect(i.log.error).toHaveBeenCalledWith(expect.stringContaining("Poll failed: JSON parse error"));
    expect(i.lastErrorCode).toBe("PARSE_ERROR");

    i.lastPollTime = 0;
    i.log.error.mockClear();
    await i.poll();
    expect(i.log.error).not.toHaveBeenCalled();
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("Poll failed (ongoing)"));
  });

  it("a per-delivery failure during shutdown stays at debug — teardown noise is not a warning (L2)", async () => {
    const { adapter, stateMgr } = await setupReady();
    const i = internalOf(adapter);
    stateMgr.updateDelivery.mockRejectedValue(new Error("broker closed"));
    i.unloaded = true; // stop arrived while the batch was in flight
    await i.poll();
    expect(i.log.warn).not.toHaveBeenCalledWith(expect.stringContaining("Failed to update"));
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("during shutdown"));
    // A shutdown failure must not be remembered as a per-package failure:
    // the next regular poll should warn normally rather than silently skip.
    expect(i.failedDeliveries.size).toBe(0);
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

  it("checkConnection: a non-string apiKey is rejected like a short one — no 'trim is not a function' (2026-09-02)", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    client.testConnection.mockClear();
    for (const apiKey of [12345, null, { key: "x" }, ["k"]]) {
      i.sendTo.mockClear();
      await i.onMessage({
        command: "checkConnection",
        from: "system.adapter.admin.0",
        callback: { id: 1 },
        message: { apiKey },
      });
      expect(i.sendTo, `apiKey=${JSON.stringify(apiKey)}`).toHaveBeenCalledWith(
        "system.adapter.admin.0",
        "checkConnection",
        { error: "API key is too short" },
        expect.anything(),
      );
    }
    expect(client.testConnection).not.toHaveBeenCalled();
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

  it("L2: a concurrent second Test-Connection is guarded — one API call, not two", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    client.testConnection.mockClear();
    i.sendTo.mockClear();
    // Make the first test hang so the second arrives while it is still in flight.
    let release: (v: { success: boolean; message: string }) => void = () => {};
    client.testConnection.mockReturnValueOnce(
      new Promise<{ success: boolean; message: string }>(r => {
        release = r;
      }),
    );
    const msg = (): unknown => ({
      command: "checkConnection",
      from: "system.adapter.admin.0",
      callback: { id: 1 },
      message: { apiKey: "0123456789abcdef" },
    });
    const first = i.onMessage(msg()); // hangs in testConnection
    await i.onMessage(msg()); // arrives while the first is in flight → must be guarded
    // The guarded second call must NOT fire another API request and must reply
    // with an explicit "already running" error rather than burning a GET.
    expect(client.testConnection).toHaveBeenCalledTimes(1);
    expect(i.sendTo).toHaveBeenCalledWith(
      "system.adapter.admin.0",
      "checkConnection",
      { error: expect.stringContaining("already running") },
      expect.anything(),
    );
    release({ success: true, message: "ok" });
    await first;
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

  it("ignores broadcasts without a callback instead of answering into the void", async () => {
    // A message without callback (broadcast) must be traced and dropped — any
    // sendTo reply would go nowhere and a throw would escape the handler.
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    i.sendTo.mockClear();
    await expect(i.onMessage({ command: "addDelivery", from: "x", message: {} })).resolves.toBeUndefined();
    await expect(i.onMessage({ from: "x", callback: { id: 1 } })).resolves.toBeUndefined();
    await expect(i.onMessage(null)).resolves.toBeUndefined();
    expect(i.sendTo).not.toHaveBeenCalled();
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
