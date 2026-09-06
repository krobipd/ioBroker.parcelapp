import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const i18nDir = join(__dirname, "../../admin/i18n");
const i18nData: Record<string, Record<string, string>> = {};
for (const f of readdirSync(i18nDir).filter(f => f.endsWith(".json"))) {
  i18nData[f.replace(".json", "")] = JSON.parse(readFileSync(join(i18nDir, f), "utf8"));
}

const fillArgs = (text: string, args: (string | number | boolean | null)[]): string => {
  for (const arg of args) {
    text = text.replace("%s", arg === null ? "null" : String(arg));
  }
  return text;
};
vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: vi.fn((key: string) => ({ en: i18nData.en?.[key] ?? key })),
    translate: vi.fn((key: string, ...args: (string | number | boolean | null)[]) =>
      fillArgs(i18nData.en?.[key] ?? key, args),
    ),
  },
}));

import {
  calculateCombinedWindow,
  calculateDeliveryEstimate,
  calculateDeliveryWindow,
  extractLastLocation,
  formatLastEvent,
  isToday,
  parseExpectedToMs,
  windowBoundsMs,
} from "./delivery-view";
import type { ParcelDelivery } from "./types";

/**
 * Fixed wall clock — mid-June, midday: no DST switch, no month or year boundary. Every
 * "today/tomorrow/overdue" expectation is built against this.
 */
const FIXED_NOW = new Date(2026, 5, 15, 12, 0, 0);

/** Collects the drift lines the module emits, so a silent parse can be told from a reported one. */
function makeLog(): { debug: (m: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { debug: (m: string): void => void lines.push(m), lines };
}

/**
 * Build a delivery fixture.
 *
 * @param overrides Fields to override on the default in-transit delivery
 * @returns the delivery
 */
function makeDelivery(overrides: Partial<ParcelDelivery> = {}): ParcelDelivery {
  return {
    carrier_code: "dhl",
    description: "Test Package",
    status_code: 2,
    tracking_number: "1234567890",
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("parseExpectedToMs", () => {
  it("parses the documented default format with a time of day", () => {
    const parsed = parseExpectedToMs("2026-06-15 14:30:00");
    expect(parsed).not.toBeNull();
    expect(parsed!.hasTime).toBe(true);
    expect(new Date(parsed!.ms).getHours()).toBe(14);
  });

  it("treats midnight as a day, not an hour window", () => {
    expect(parseExpectedToMs("2026-06-15 00:00:00")!.hasTime).toBe(false);
    expect(parseExpectedToMs("2026-06-15")!.hasTime).toBe(false);
  });

  /**
   * v0.12.0 (audit B2). The parser knew exactly one format. `Ressourcen/parcelapp/
   * api-clients-und-feldformate.md` documents `"MMMM dd, yyyy HH:mm"` as a real carrier format
   * that the most thorough production client parses — and it is UNAMBIGUOUS, so the "we do not
   * guess ambiguous formats" rule never covered it. Before the fix these packages showed an empty
   * window and an empty estimate.
   */
  describe("English month-name format (v0.12.0)", () => {
    it("parses 'December 06, 2025 14:30'", () => {
      const parsed = parseExpectedToMs("December 06, 2025 14:30");
      expect(parsed).not.toBeNull();
      expect(parsed!.hasTime).toBe(true);
      const d = new Date(parsed!.ms);
      expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2025, 11, 6, 14, 30]);
    });

    it("accepts a single-digit day and a missing time", () => {
      const parsed = parseExpectedToMs("March 7, 2026");
      expect(parsed).not.toBeNull();
      expect(parsed!.hasTime).toBe(false);
      expect(new Date(parsed!.ms).getMonth()).toBe(2);
    });

    it("keeps the seconds when the carrier sends them", () => {
      const parsed = parseExpectedToMs("December 6, 2025 14:30:45");
      expect(parsed).not.toBeNull();
      expect(new Date(parsed!.ms).getSeconds()).toBe(45);
    });

    it("is case-insensitive on the month name", () => {
      expect(parseExpectedToMs("JULY 4, 2026")).not.toBeNull();
    });

    it("rejects an abbreviated month rather than guessing", () => {
      const log = makeLog();
      expect(parseExpectedToMs("Dec 06, 2025 14:30", log)).toBeNull();
      expect(log.lines.join()).toContain("unsupported format");
    });

    it("rejects an impossible day in a named month", () => {
      const log = makeLog();
      expect(parseExpectedToMs("February 30, 2026", log)).toBeNull();
      expect(log.lines.join()).toContain("not a real calendar date");
    });
  });

  describe("ambiguous formats stay unparsed — but are no longer silent (v0.12.0)", () => {
    it("reports a dotted date instead of dropping it without a trace", () => {
      const log = makeLog();
      expect(parseExpectedToMs("06.12.2025 14:30", log)).toBeNull();
      expect(log.lines).toHaveLength(1);
      expect(log.lines[0]).toContain("06.12.2025 14:30");
    });

    it("reports a weekday format", () => {
      const log = makeLog();
      expect(parseExpectedToMs("Saturday, 6 December 2:30 pm", log)).toBeNull();
      expect(log.lines.join()).toContain("unsupported format");
    });

    it("reports an ISO string with a timezone suffix — the API is documented without one", () => {
      const log = makeLog();
      expect(parseExpectedToMs("2026-06-15T14:30:00Z", log)).toBeNull();
      expect(log.lines.join()).toContain("unsupported format");
    });

    it("reports an out-of-range time", () => {
      const log = makeLog();
      expect(parseExpectedToMs("2026-06-15 25:00:00", log)).toBeNull();
      expect(log.lines.join()).toContain("time out of range");
    });

    it("reports an out-of-range month", () => {
      const log = makeLog();
      expect(parseExpectedToMs("2026-13-15", log)).toBeNull();
      expect(log.lines.join()).toContain("month/day out of range");
    });

    it("reports a present but wrong-typed value", () => {
      const log = makeLog();
      expect(parseExpectedToMs(1765030200, log)).toBeNull();
      expect(log.lines.join()).toContain("not a string");
    });

    it("stays SILENT when the carrier simply reports nothing", () => {
      const log = makeLog();
      expect(parseExpectedToMs(undefined, log)).toBeNull();
      expect(parseExpectedToMs(null, log)).toBeNull();
      expect(parseExpectedToMs("   ", log)).toBeNull();
      expect(log.lines).toEqual([]);
    });
  });
});

describe("windowBoundsMs", () => {
  it("prefers the unix timestamps over the strings", () => {
    const start = Math.floor(new Date(2026, 5, 15, 9, 0, 0).getTime() / 1000);
    const bounds = windowBoundsMs(makeDelivery({ timestamp_expected: start, date_expected: "2026-06-15 17:00:00" }), 2);
    expect(new Date(bounds!.start).getHours()).toBe(9);
  });

  it("returns null for a non-trackable status", () => {
    expect(windowBoundsMs(makeDelivery({ date_expected: "2026-06-15 09:00:00" }), 0)).toBeNull();
  });

  it("uses the month-name string when no timestamp is given", () => {
    const bounds = windowBoundsMs(makeDelivery({ date_expected: "June 15, 2026 9:15" }), 2);
    expect(bounds).not.toBeNull();
    expect(new Date(bounds!.start).getMinutes()).toBe(15);
  });
});

describe("calculateDeliveryWindow", () => {
  it("renders a same-day window as HH:MM - HH:MM", () => {
    const d = makeDelivery({ date_expected: "2026-06-15 09:00:00", date_expected_end: "2026-06-15 13:00:00" });
    expect(calculateDeliveryWindow(d, 2)).toBe("09:00 - 13:00");
  });

  it("carries the date on both sides when the window spans days", () => {
    const d = makeDelivery({ date_expected: "2026-06-15 09:00:00", date_expected_end: "2026-06-17 13:00:00" });
    expect(calculateDeliveryWindow(d, 2)).toBe("06-15 09:00 - 06-17 13:00");
  });

  it("renders only the start when the end is not after it", () => {
    const d = makeDelivery({ date_expected: "2026-06-15 09:00:00", date_expected_end: "2026-06-15 08:00:00" });
    expect(calculateDeliveryWindow(d, 2)).toBe("09:00");
  });

  it("fills a window for a carrier that reports the month-name format (v0.12.0)", () => {
    const d = makeDelivery({ date_expected: "June 15, 2026 9:00", date_expected_end: "June 15, 2026 13:00" });
    expect(calculateDeliveryWindow(d, 2)).toBe("09:00 - 13:00");
  });
});

describe("calculateDeliveryEstimate / isToday", () => {
  it("says today for a package expected today", () => {
    const d = makeDelivery({ date_expected: "2026-06-15" });
    expect(calculateDeliveryEstimate(d, 2)).toBe("today");
    expect(isToday(d, 2)).toBe(true);
  });

  it("says tomorrow, in N days and overdue", () => {
    expect(calculateDeliveryEstimate(makeDelivery({ date_expected: "2026-06-16" }), 2)).toBe("tomorrow");
    expect(calculateDeliveryEstimate(makeDelivery({ date_expected: "2026-06-18" }), 2)).toBe("in 3 days");
    expect(calculateDeliveryEstimate(makeDelivery({ date_expected: "2026-06-14" }), 2)).toBe("overdue");
  });

  it("counts a month-name date towards today (v0.12.0)", () => {
    expect(isToday(makeDelivery({ date_expected: "June 15, 2026" }), 2)).toBe(true);
  });

  it("is empty for a non-trackable status", () => {
    expect(calculateDeliveryEstimate(makeDelivery({ date_expected: "2026-06-15" }), 0)).toBe("");
  });
});

describe("calculateCombinedWindow", () => {
  it("spans the earliest start to the LATEST end, not the end of the latest start", () => {
    const entries = [
      {
        delivery: makeDelivery({ date_expected: "2026-06-15 10:00:00", date_expected_end: "2026-06-15 18:00:00" }),
        statusCode: 2,
      },
      {
        delivery: makeDelivery({ date_expected: "2026-06-15 12:00:00", date_expected_end: "2026-06-15 14:00:00" }),
        statusCode: 2,
      },
    ];
    expect(calculateCombinedWindow(entries)).toBe("10:00 - 18:00");
  });

  it("is empty when no package reports a usable window", () => {
    expect(calculateCombinedWindow([{ delivery: makeDelivery(), statusCode: 2 }])).toBe("");
  });
});

describe("event formatting", () => {
  it("joins event and date, dropping whichever half is missing", () => {
    expect(formatLastEvent(makeDelivery({ events: [{ event: "Arrived", date: "2026-06-15" }] }))).toBe(
      "Arrived - 2026-06-15",
    );
    expect(formatLastEvent(makeDelivery({ events: [{ event: "Arrived" }] }))).toBe("Arrived");
    expect(formatLastEvent(makeDelivery({ events: [{ date: "2026-06-15" }] }))).toBe("2026-06-15");
  });

  it("takes events[0] as the newest", () => {
    const d = makeDelivery({ events: [{ event: "Newest" }, { event: "Older" }] });
    expect(formatLastEvent(d)).toBe("Newest");
  });

  it("survives a missing, empty or wrong-typed events list", () => {
    expect(formatLastEvent(makeDelivery())).toBe("");
    expect(formatLastEvent(makeDelivery({ events: [] }))).toBe("");
    expect(formatLastEvent(makeDelivery({ events: [null as unknown as never] }))).toBe("");
    expect(extractLastLocation(makeDelivery({ events: "nope" as unknown as never }))).toBe("");
  });

  it("returns the location of the newest event only when it is a string", () => {
    expect(extractLastLocation(makeDelivery({ events: [{ location: "Hub" }] }))).toBe("Hub");
    expect(extractLastLocation(makeDelivery({ events: [{ location: 42 as unknown as string }] }))).toBe("");
  });
});
