import http from "node:http";
import net from "node:net";
import { coerceClampedInt, coerceFiniteNumber, errText, isTrueish, oneLine } from "./coerce";

describe("coerceFiniteNumber", () => {
  it("returns finite numbers as-is", () => {
    expect(coerceFiniteNumber(42)).toBe(42);
    expect(coerceFiniteNumber(0)).toBe(0);
    expect(coerceFiniteNumber(-1.5)).toBe(-1.5);
  });

  it("rejects NaN and Infinity", () => {
    expect(coerceFiniteNumber(NaN)).toBeNull();
    expect(coerceFiniteNumber(Infinity)).toBeNull();
    expect(coerceFiniteNumber(-Infinity)).toBeNull();
  });

  it("parses valid decimal strings", () => {
    expect(coerceFiniteNumber("123.45")).toBe(123.45);
    expect(coerceFiniteNumber("-0.5")).toBe(-0.5);
    expect(coerceFiniteNumber("-42")).toBe(-42);
  });

  it("rejects empty string and non-numeric", () => {
    expect(coerceFiniteNumber("")).toBeNull();
    expect(coerceFiniteNumber("abc")).toBeNull();
    expect(coerceFiniteNumber({})).toBeNull();
    expect(coerceFiniteNumber(null)).toBeNull();
    expect(coerceFiniteNumber(undefined)).toBeNull();
  });

  it("rejects HEX strings (firmware drift / corrupted payload guard)", () => {
    expect(coerceFiniteNumber("0x1FBB")).toBeNull();
    expect(coerceFiniteNumber("0X10")).toBeNull();
  });

  it("rejects exponential notation strings", () => {
    expect(coerceFiniteNumber("1e3")).toBeNull();
    expect(coerceFiniteNumber("2.5E-3")).toBeNull();
  });

  it("rejects a digit string so long that it parses to Infinity", () => {
    // The regex only checks the SHAPE (digits, optional fraction); a 400-digit
    // number still passes it and then overflows to Infinity. Without the
    // isFinite check that Infinity would land in an ioBroker state.
    expect(coerceFiniteNumber("9".repeat(400))).toBeNull();
    expect(coerceFiniteNumber(`-${"9".repeat(400)}`)).toBeNull();
    // A long-but-finite value must still pass (loses precision like any JS
    // number, but stays a usable finite number rather than being dropped).
    const long = coerceFiniteNumber("12345678901234567890");
    expect(long).not.toBeNull();
    expect(Number.isFinite(long)).toBe(true);
  });

  it("rejects strings with leading/trailing whitespace or signs", () => {
    expect(coerceFiniteNumber(" 42")).toBeNull();
    expect(coerceFiniteNumber("42 ")).toBeNull();
    expect(coerceFiniteNumber("+42")).toBeNull();
    expect(coerceFiniteNumber(".5")).toBeNull();
    expect(coerceFiniteNumber("5.")).toBeNull();
  });
});

describe("isTrueish (parcel.app success-flag drift guard)", () => {
  it("accepts real booleans as-is", () => {
    expect(isTrueish(true)).toBe(true);
    expect(isTrueish(false)).toBe(false);
  });

  it("treats numeric 1 as true, 0 as false", () => {
    expect(isTrueish(1)).toBe(true);
    expect(isTrueish(0)).toBe(false);
    expect(isTrueish(2)).toBe(false);
    expect(isTrueish(-1)).toBe(false);
  });

  it("accepts 'true' / 'TRUE' / '1' as true (case-insensitive)", () => {
    expect(isTrueish("true")).toBe(true);
    expect(isTrueish("TRUE")).toBe(true);
    expect(isTrueish("True")).toBe(true);
    expect(isTrueish("1")).toBe(true);
  });

  it("rejects 'false', '0', '', and other strings", () => {
    expect(isTrueish("false")).toBe(false);
    expect(isTrueish("0")).toBe(false);
    expect(isTrueish("")).toBe(false);
    expect(isTrueish("yes")).toBe(false);
  });

  it("rejects non-primitives", () => {
    expect(isTrueish(null)).toBe(false);
    expect(isTrueish(undefined)).toBe(false);
    expect(isTrueish({})).toBe(false);
    expect(isTrueish([])).toBe(false);
  });
});

describe("errText", () => {
  it("returns Error.message for Error instances", () => {
    expect(errText(new Error("boom"))).toBe("boom");
  });

  it("returns 'null' for null and 'undefined' for undefined", () => {
    expect(errText(null)).toBe("null");
    expect(errText(undefined)).toBe("undefined");
  });

  it("returns strings as-is and primitives via String()", () => {
    expect(errText("plain string")).toBe("plain string");
    expect(errText(42)).toBe("42");
    expect(errText(true)).toBe("true");
  });

  it("JSON-stringifies plain objects (avoids [object Object])", () => {
    expect(errText({ code: "ECONN", port: 443 })).toBe('{"code":"ECONN","port":443}');
  });

  it("handles a custom Error subclass", () => {
    class MyErr extends Error {
      constructor() {
        super("custom");
        this.name = "MyErr";
      }
    }
    expect(errText(new MyErr())).toBe("custom");
  });

  // The contract this whole helper exists for: it is interpolated into log
  // lines, so it must ALWAYS return a string. Every branch below used to be
  // unreachable for the tests (coverage gap, audit 2026-08-22 C12/D15) and one
  // of them was genuinely broken.
  it("falls back to the object tag for a circular structure (JSON.stringify throws)", () => {
    const circular: Record<string, unknown> = { code: "ECONN" };
    circular.self = circular;
    expect(errText(circular)).toBe("[object Object]");
  });

  it("returns a string for a thrown symbol (JSON.stringify yields undefined, it does NOT throw)", () => {
    // Regression guard: the catch never runs for a symbol, so the old code
    // returned `undefined` while declaring `string` — the log line read
    // "Poll failed: undefined".
    const result = errText(Symbol("boom"));
    expect(typeof result).toBe("string");
    expect(result).toContain("boom");
  });

  it("returns a string for a thrown function (JSON.stringify yields undefined too)", () => {
    const result = errText(() => 42);
    expect(typeof result).toBe("string");
    expect(result).toBe("[object Function]");
  });

  it("never returns a non-string, whatever it is handed", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const inputs: unknown[] = [
      new Error("e"),
      null,
      undefined,
      "text",
      42,
      true,
      10n,
      Symbol("s"),
      { a: 1 },
      [1, 2],
      () => 0,
      circular,
      new Date(0),
      NaN,
    ];
    for (const input of inputs) {
      expect(typeof errText(input), `errText(${String(typeof input)})`).toBe("string");
    }
  });
});

// Fleet master test of the error-text helper (Entwicklung/CLAUDE_CODING.md, section on error text only through the helper).
/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const s = net.createServer().listen(0);
  await new Promise(r => s.once("listening", r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise(r => s.close(r));
  return port;
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("did not reject");
}

describe("errText — measured Node errors", () => {
  it("fetch, unknown host: the DNS reason", async () => {
    // `.invalid` never resolves (RFC 6761); a runner without DNS says EAI_AGAIN instead of ENOTFOUND.
    expect(errText(await rejection(fetch("http://nonexistent.invalid/")))).toMatch(
      /^fetch failed \(getaddrinfo E[A-Z_]+ nonexistent\.invalid\)$/,
    );
  });
  it("fetch, refused on an address: the socket reason", async () => {
    const port = await closedPort();
    expect(errText(await rejection(fetch(`http://127.0.0.1:${port}/`)))).toBe(
      `fetch failed (connect ECONNREFUSED 127.0.0.1:${port})`,
    );
  });
  it("fetch, peer drops the socket: undici's words", async () => {
    const srv = http.createServer(q => q.socket.destroy()).listen(0);
    await new Promise(r => srv.once("listening", r));
    const port = (srv.address() as net.AddressInfo).port;
    const text = errText(await rejection(fetch(`http://127.0.0.1:${port}/`)));
    await new Promise(r => srv.close(r));
    expect(text).toBe("fetch failed (other side closed)");
  });
  it("fetch, timeout: the DOMException's own words, no cause", async () => {
    const srv = http.createServer(() => undefined).listen(0);
    await new Promise(r => srv.once("listening", r));
    const port = (srv.address() as net.AddressInfo).port;
    const e = await rejection(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(100) }));
    srv.closeAllConnections();
    await new Promise(r => srv.close(r));
    expect(errText(e)).toBe("The operation was aborted due to timeout");
  });
  it("http.get/net.connect to localhost, refused: an empty message says its code", () => {
    // The shape Node 22 rejects with when both ::1 and 127.0.0.1 refuse (built here: whether
    // `localhost` has two addresses depends on the runner's hosts file).
    const e = Object.assign(new AggregateError([], ""), {
      code: "ECONNREFUSED",
    });
    expect(errText(e)).toBe("ECONNREFUSED");
    expect(errText(new TypeError("fetch failed", { cause: e }))).toBe("fetch failed (ECONNREFUSED)");
  });
});

describe("errText — shapes of a cause", () => {
  it("a string, a plain object, a number", () => {
    expect(errText(new Error("x", { cause: "busy" }))).toBe("x (busy)");
    expect(errText(new Error("x", { cause: { code: "ECONNRESET" } }))).toBe('x ({"code":"ECONNRESET"})');
    expect(errText(new Error("x", { cause: 42 }))).toBe("x (42)");
  });
  it("undefined and null add nothing", () => {
    expect(errText(new Error("x", { cause: undefined }))).toBe("x");
    expect(errText(new Error("x", { cause: null }))).toBe("x");
  });
  it("one level only: a cause's own cause is not followed, a self-cause does not loop", () => {
    const inner = new Error("inner", { cause: new Error("deepest") });
    expect(errText(new Error("outer", { cause: inner }))).toBe("outer (inner)");
    const self = new Error("self");
    self.cause = self;
    expect(errText(self)).toBe("self");
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    a.cause = b;
    expect(errText(a)).toBe("a (b)");
  });
  it("a wrapper that copies its cause's message says it once", () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND api.x"), {
      code: "ENOTFOUND",
    });
    expect(
      errText(
        Object.assign(new Error("getaddrinfo ENOTFOUND api.x", { cause }), {
          code: "ENOTFOUND",
        }),
      ),
    ).toBe("getaddrinfo ENOTFOUND api.x");
  });
  it("an empty cause message without a code adds nothing; an empty message without a code says the name", () => {
    expect(errText(new Error("x", { cause: new Error("") }))).toBe("x");
    expect(errText(new TypeError(""))).toBe("TypeError");
  });
  it("a cause that is an empty-message AggregateError says its code", () => {
    const agg = Object.assign(new AggregateError([], ""), {
      code: "ECONNREFUSED",
    });
    expect(errText(new TypeError("fetch failed", { cause: agg }))).toBe("fetch failed (ECONNREFUSED)");
  });
});

describe("errText — the non-Error branches stay", () => {
  it("renders every thrown value", () => {
    expect(errText("s")).toBe("s");
    expect(errText(undefined)).toBe("undefined");
    expect(errText(null)).toBe("null");
    expect(errText(1n)).toBe("1");
    expect(errText(Symbol("q"))).toBe("Symbol(q)");
    expect(errText({ code: "ECONNRESET" })).toBe('{"code":"ECONNRESET"}');
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(errText(cyc)).toBe("[object Object]");
  });
});
describe("errText — it never throws and never prints source text", () => {
  it("a thrown function or class renders as its type tag", () => {
    expect(
      errText(function secretFn(a: number): number {
        return a + 1;
      }),
    ).toBe("[object Function]");
    expect(errText(class Secret {})).toBe("[object Function]");
    expect(errText(async () => Promise.resolve())).toBe("[object AsyncFunction]");
  });
  it("a `code` or `cause` getter that throws gives the type tag instead of a second throw", () => {
    const code = new Error("m");
    Object.defineProperty(code, "code", {
      get(): never {
        throw new Error("getter");
      },
    });
    expect(errText(code)).toBe("[object Error]");
    const cause = new Error("m");
    Object.defineProperty(cause, "cause", {
      get(): never {
        throw new Error("getter");
      },
    });
    expect(errText(cause)).toBe("[object Error]");
  });
  it("a message that is not a string is still text, with and without a cause", () => {
    const withCause = new Error("x", { cause: "busy" });
    Object.defineProperty(withCause, "message", { value: 42 });
    expect(errText(withCause)).toBe("42 (busy)");
    const plain = new Error("x");
    Object.defineProperty(plain, "message", { value: 42 });
    expect(errText(plain)).toBe("42");
  });
});

// ---------------------------------------------------------------------------
// coerceClampedInt (X5 v0.4.2)
// ---------------------------------------------------------------------------

describe("coerceClampedInt (X5 v0.4.2)", () => {
  it("returns numbers in range as-is (floored)", () => {
    expect(coerceClampedInt(15, 5, 60, 10)).toBe(15);
    expect(coerceClampedInt(15.7, 5, 60, 10)).toBe(15);
  });

  it("clamps below min", () => {
    expect(coerceClampedInt(2, 5, 60, 10)).toBe(5);
    expect(coerceClampedInt(-100, 5, 60, 10)).toBe(5);
  });

  it("clamps above max", () => {
    expect(coerceClampedInt(120, 5, 60, 10)).toBe(60);
  });

  it("parses numeric strings (admin can store config as string)", () => {
    expect(coerceClampedInt("15", 5, 60, 10)).toBe(15);
    expect(coerceClampedInt("3", 5, 60, 10)).toBe(5);
  });

  it("returns default for non-finite / unparseable inputs (NaN-trap fix)", () => {
    expect(coerceClampedInt(undefined, 5, 60, 10)).toBe(10);
    expect(coerceClampedInt(null, 5, 60, 10)).toBe(10);
    expect(coerceClampedInt(NaN, 5, 60, 10)).toBe(10);
    expect(coerceClampedInt(Infinity, 5, 60, 10)).toBe(10);
    expect(coerceClampedInt("", 5, 60, 10)).toBe(10);
    expect(coerceClampedInt("abc", 5, 60, 10)).toBe(10);
    expect(coerceClampedInt({}, 5, 60, 10)).toBe(10);
  });
});

describe("oneLine", () => {
  it("renders a non-string instead of throwing (audit B5: a drifted number used to throw here)", () => {
    expect(oneLine(12345)).toBe("12345");
    expect(oneLine(undefined)).toBe("undefined");
    expect(oneLine({ a: "x\ny" })).toBe('{"a":"x\\ny"}');
  });

  it("collapses CR / LF / TAB runs to single spaces (log-injection guard)", () => {
    expect(oneLine("a\r\nb")).toBe("a b");
    expect(oneLine("evil\nINFO 2026 forged log line")).toBe("evil INFO 2026 forged log line");
    expect(oneLine("a\t\tb")).toBe("a b");
  });

  it("leaves single-line input unchanged", () => {
    expect(oneLine("plain text 123")).toBe("plain text 123");
    expect(oneLine("")).toBe("");
  });

  it("flattens the rest of the C0 range and DEL as well — terminal escapes included (2026-09-02)", () => {
    expect(oneLine("a\u001b[31mred\u001b[0mb")).toBe("a [31mred [0mb");
    expect(oneLine("a\u007fb")).toBe("a b");
    expect(oneLine("a\u0001\u0002\u001fb")).toBe("a b"); // one run → ONE space
  });

  it("leaves non-ASCII text alone", () => {
    expect(oneLine("Paket für München — ✓")).toBe("Paket für München — ✓");
  });

  it("flattens NUL / VT / FF and Unicode line separators too (v0.10.0, I10)", () => {
    expect(oneLine("a\0b")).toBe("a b"); // collision raw-key separator
    expect(oneLine("a\vb")).toBe("a b");
    expect(oneLine("a\fb")).toBe("a b");
    expect(oneLine("a\u2028b")).toBe("a b");
    expect(oneLine("a\u2029b")).toBe("a b");
    expect(oneLine("a\0\r\n\u2028b")).toBe("a b"); // mixed run → ONE space
  });
});
