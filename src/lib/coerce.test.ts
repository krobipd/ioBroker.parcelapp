import { expect } from "chai";
import {
  coerceBoolean,
  coerceClampedInt,
  coerceFiniteNumber,
  coerceString,
  errText,
  isPlainObject,
  isTrueish,
} from "./coerce";

describe("coerceFiniteNumber", () => {
  it("returns finite numbers as-is", () => {
    expect(coerceFiniteNumber(42)).to.equal(42);
    expect(coerceFiniteNumber(0)).to.equal(0);
    expect(coerceFiniteNumber(-1.5)).to.equal(-1.5);
  });

  it("rejects NaN and Infinity", () => {
    expect(coerceFiniteNumber(NaN)).to.be.null;
    expect(coerceFiniteNumber(Infinity)).to.be.null;
    expect(coerceFiniteNumber(-Infinity)).to.be.null;
  });

  it("parses valid decimal strings", () => {
    expect(coerceFiniteNumber("123.45")).to.equal(123.45);
    expect(coerceFiniteNumber("-0.5")).to.equal(-0.5);
    expect(coerceFiniteNumber("-42")).to.equal(-42);
  });

  it("rejects empty string and non-numeric", () => {
    expect(coerceFiniteNumber("")).to.be.null;
    expect(coerceFiniteNumber("abc")).to.be.null;
    expect(coerceFiniteNumber({})).to.be.null;
    expect(coerceFiniteNumber(null)).to.be.null;
    expect(coerceFiniteNumber(undefined)).to.be.null;
  });

  it("rejects HEX strings (firmware drift / corrupted payload guard)", () => {
    expect(coerceFiniteNumber("0x1FBB")).to.be.null;
    expect(coerceFiniteNumber("0X10")).to.be.null;
  });

  it("rejects exponential notation strings", () => {
    expect(coerceFiniteNumber("1e3")).to.be.null;
    expect(coerceFiniteNumber("2.5E-3")).to.be.null;
  });

  it("rejects strings with leading/trailing whitespace or signs", () => {
    expect(coerceFiniteNumber(" 42")).to.be.null;
    expect(coerceFiniteNumber("42 ")).to.be.null;
    expect(coerceFiniteNumber("+42")).to.be.null;
    expect(coerceFiniteNumber(".5")).to.be.null;
    expect(coerceFiniteNumber("5.")).to.be.null;
  });
});

describe("coerceString", () => {
  it("returns non-empty strings", () => {
    expect(coerceString("hello")).to.equal("hello");
  });

  it("rejects empty string and non-string", () => {
    expect(coerceString("")).to.be.null;
    expect(coerceString(42)).to.be.null;
    expect(coerceString(null)).to.be.null;
    expect(coerceString(undefined)).to.be.null;
    expect(coerceString({})).to.be.null;
  });
});

describe("coerceBoolean", () => {
  it("returns booleans as-is", () => {
    expect(coerceBoolean(true)).to.be.true;
    expect(coerceBoolean(false)).to.be.false;
  });

  it("rejects truthy/falsy non-booleans", () => {
    expect(coerceBoolean(1)).to.be.null;
    expect(coerceBoolean(0)).to.be.null;
    expect(coerceBoolean("true")).to.be.null;
    expect(coerceBoolean(null)).to.be.null;
    expect(coerceBoolean(undefined)).to.be.null;
  });
});

describe("isPlainObject", () => {
  it("accepts plain objects", () => {
    expect(isPlainObject({})).to.be.true;
    expect(isPlainObject({ a: 1 })).to.be.true;
  });

  it("rejects arrays, null, primitives", () => {
    expect(isPlainObject([])).to.be.false;
    expect(isPlainObject(null)).to.be.false;
    expect(isPlainObject("x")).to.be.false;
    expect(isPlainObject(42)).to.be.false;
    expect(isPlainObject(undefined)).to.be.false;
  });
});

describe("isTrueish (parcel.app success-flag drift guard)", () => {
  it("accepts real booleans as-is", () => {
    expect(isTrueish(true)).to.be.true;
    expect(isTrueish(false)).to.be.false;
  });

  it("treats numeric 1 as true, 0 as false", () => {
    expect(isTrueish(1)).to.be.true;
    expect(isTrueish(0)).to.be.false;
    expect(isTrueish(2)).to.be.false;
    expect(isTrueish(-1)).to.be.false;
  });

  it("accepts 'true' / 'TRUE' / '1' as true (case-insensitive)", () => {
    expect(isTrueish("true")).to.be.true;
    expect(isTrueish("TRUE")).to.be.true;
    expect(isTrueish("True")).to.be.true;
    expect(isTrueish("1")).to.be.true;
  });

  it("rejects 'false', '0', '', and other strings", () => {
    expect(isTrueish("false")).to.be.false;
    expect(isTrueish("0")).to.be.false;
    expect(isTrueish("")).to.be.false;
    expect(isTrueish("yes")).to.be.false;
  });

  it("rejects non-primitives", () => {
    expect(isTrueish(null)).to.be.false;
    expect(isTrueish(undefined)).to.be.false;
    expect(isTrueish({})).to.be.false;
    expect(isTrueish([])).to.be.false;
  });
});

describe("errText", () => {
  it("returns Error.message for Error instances", () => {
    expect(errText(new Error("boom"))).to.equal("boom");
  });

  it("returns 'null' for null and 'undefined' for undefined", () => {
    expect(errText(null)).to.equal("null");
    expect(errText(undefined)).to.equal("undefined");
  });

  it("returns strings as-is and primitives via String()", () => {
    expect(errText("plain string")).to.equal("plain string");
    expect(errText(42)).to.equal("42");
    expect(errText(true)).to.equal("true");
  });

  it("JSON-stringifies plain objects (avoids [object Object])", () => {
    expect(errText({ code: "ECONN", port: 443 })).to.equal('{"code":"ECONN","port":443}');
  });

  it("handles a custom Error subclass", () => {
    class MyErr extends Error {
      constructor() {
        super("custom");
        this.name = "MyErr";
      }
    }
    expect(errText(new MyErr())).to.equal("custom");
  });
});

// ---------------------------------------------------------------------------
// coerceClampedInt (X5 v0.4.2)
// ---------------------------------------------------------------------------

describe("coerceClampedInt (X5 v0.4.2)", () => {
  it("returns numbers in range as-is (floored)", () => {
    expect(coerceClampedInt(15, 5, 60, 10)).to.equal(15);
    expect(coerceClampedInt(15.7, 5, 60, 10)).to.equal(15);
  });

  it("clamps below min", () => {
    expect(coerceClampedInt(2, 5, 60, 10)).to.equal(5);
    expect(coerceClampedInt(-100, 5, 60, 10)).to.equal(5);
  });

  it("clamps above max", () => {
    expect(coerceClampedInt(120, 5, 60, 10)).to.equal(60);
  });

  it("parses numeric strings (admin can store config as string)", () => {
    expect(coerceClampedInt("15", 5, 60, 10)).to.equal(15);
    expect(coerceClampedInt("3", 5, 60, 10)).to.equal(5);
  });

  it("returns default for non-finite / unparseable inputs (NaN-trap fix)", () => {
    expect(coerceClampedInt(undefined, 5, 60, 10)).to.equal(10);
    expect(coerceClampedInt(null, 5, 60, 10)).to.equal(10);
    expect(coerceClampedInt(NaN, 5, 60, 10)).to.equal(10);
    expect(coerceClampedInt(Infinity, 5, 60, 10)).to.equal(10);
    expect(coerceClampedInt("", 5, 60, 10)).to.equal(10);
    expect(coerceClampedInt("abc", 5, 60, 10)).to.equal(10);
    expect(coerceClampedInt({}, 5, 60, 10)).to.equal(10);
  });
});
