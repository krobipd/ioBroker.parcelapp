import { bareId, candidateIndex, identityOf, idCandidates, rawIdKey, shortHash, suffixKey } from "./package-id";
import type { ParcelDelivery } from "./types";

function makeDelivery(overrides: Partial<ParcelDelivery> = {}): ParcelDelivery {
  return { carrier_code: "dhl", description: "x", status_code: 2, tracking_number: "ABC-123", ...overrides };
}

/**
 * The first `count` candidates of a delivery.
 *
 * @param delivery The delivery
 * @param count How many
 * @returns the candidate ids
 */
function firstCandidates(delivery: ParcelDelivery, count: number): string[] {
  const result: string[] = [];
  for (const id of idCandidates(delivery)) {
    result.push(id);
    if (result.length === count) {
      break;
    }
  }
  return result;
}

describe("package-id (audit 2026-09-25, S1/S3)", () => {
  it("tries the bare id, the carrier-less suffix of v0.13.0, the carrier suffix, then numbered ids", () => {
    const d = makeDelivery();
    const identity = identityOf(d);
    const withCarrier = `abc_123__${shortHash(rawIdKey(identity))}`;
    expect(firstCandidates(d, 5)).toEqual([
      "abc_123",
      `abc_123__${shortHash(suffixKey(identity))}`,
      withCarrier,
      `${withCarrier}_2`,
      `${withCarrier}_3`,
    ]);
    expect(bareId(d)).toBe("abc_123");
  });

  it("the second candidate is exactly the v0.13.0 suffix — existing ids stay put", () => {
    // FNV-1a over "ABC-123\0" — the value v0.13.0 wrote for this tracking number.
    expect(firstCandidates(makeDelivery(), 2)[1]).toBe(`abc_123__${shortHash("ABC-123\u0000")}`);
    expect(firstCandidates(makeDelivery({ carrier_code: "ups" }), 2)[1]).toBe(firstCandidates(makeDelivery(), 2)[1]);
  });

  it("two carriers whose carrier suffix clashes still get two ids", () => {
    // "c5829" and "c15039" hash to the same six characters for this number (searched once).
    const a = makeDelivery({ tracking_number: "SAME-9", carrier_code: "c5829" });
    const b = makeDelivery({ tracking_number: "SAME-9", carrier_code: "c15039" });
    expect(firstCandidates(a, 3)[2]).toBe(firstCandidates(b, 3)[2]);
    expect(firstCandidates(b, 4)[3]).toBe(`${firstCandidates(b, 3)[2]}_2`);
  });

  it("knows where an id sits in the chain", () => {
    const d = makeDelivery();
    const [bare, first, withCarrier] = firstCandidates(d, 3);
    expect(candidateIndex(bare, d)).toBe(0);
    expect(candidateIndex(first, d)).toBe(1);
    expect(candidateIndex(withCarrier, d)).toBe(2);
    expect(candidateIndex(`${withCarrier}_2`, d)).toBe(3);
    expect(candidateIndex(`${withCarrier}_7`, d)).toBe(8);
    expect(candidateIndex(`${withCarrier}_1`, d)).toBe(-1);
    expect(candidateIndex(`${withCarrier}_02`, d)).toBe(-1);
    expect(candidateIndex("something_else", d)).toBe(-1);
  });

  it("reads the identity fields as strings, empty where the API sent none", () => {
    expect(identityOf(makeDelivery({ extra_information: "50733" }))).toEqual(["ABC-123", "50733", "dhl"]);
    expect(identityOf({ tracking_number: 42, carrier_code: null } as unknown as ParcelDelivery)).toEqual(["", "", ""]);
  });
});
