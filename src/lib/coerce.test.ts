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
  it("collapses CR / LF / TAB runs to single spaces (log-injection guard)", () => {
    expect(oneLine("a\r\nb")).toBe("a b");
    expect(oneLine("evil\nINFO 2026 forged log line")).toBe("evil INFO 2026 forged log line");
    expect(oneLine("a\t\tb")).toBe("a b");
  });

  it("leaves single-line input unchanged", () => {
    expect(oneLine("plain text 123")).toBe("plain text 123");
    expect(oneLine("")).toBe("");
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
