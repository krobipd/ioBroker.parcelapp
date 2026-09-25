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
  buildNameTables,
  calculateCombinedWindow,
  calculateDeliveryEstimate,
  calculateDeliveryWindow,
  eventIsToday,
  expectedDayRange,
  extractLastLocation,
  formatLastEvent,
  isToday,
  parseExpectedToMs,
  windowBoundsMs,
} from "./delivery-view";
import type { ParcelDelivery } from "./types";

/**
 * Fixed wall clock — Monday, mid-June, midday: no DST switch, no month or year boundary. Every
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
  it("a rejected value cannot split the log line and is capped (audit X4)", () => {
    const log = makeLog();
    const lines = log.lines;
    expect(parseExpectedToMs("2026-06-15\nFORGED LINE", log)).toBeNull();
    expect(parseExpectedToMs("x".repeat(500), log)).toBeNull();
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toMatch(/[\n\r]/);
    expect(lines[0]).toContain("2026-06-15 FORGED LINE");
    expect(lines[1].length).toBeLessThan(300);
  });

  it("reads a doubled space between date and time (audit X14)", () => {
    const parsed = parseExpectedToMs("2026-06-15  14:30:00");
    expect(parsed).not.toBeNull();
    expect(parsed!.hasTime).toBe(true);
    expect(calculateDeliveryWindow(makeDelivery({ date_expected: "2026-06-15 \t09:00:00" }), 2)).toBe("09:00");
  });

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

  describe('"out for delivery" without an expected date (v0.13.0, audit O1)', () => {
    it("counts as today when the carrier scanned the parcel today", () => {
      // Plenty of carriers report status 4 and no date at all. The parcel is on the
      // van — before v0.13.0 it was missing from todayCount and had no estimate.
      const d = makeDelivery({ events: [{ event: "Out for delivery", date: "2026-06-15 07:12:00" }] });
      expect(isToday(d, 4)).toBe(true);
      expect(calculateDeliveryEstimate(d, 4)).toBe("today");
      // No date means no window — that half stays empty on purpose.
      expect(calculateDeliveryWindow(d, 4)).toBe("");
    });

    it("stays unknown when the last scan is older than today", () => {
      const d = makeDelivery({ events: [{ event: "Out for delivery", date: "2026-06-14 07:12:00" }] });
      expect(isToday(d, 4)).toBe(false);
      expect(calculateDeliveryEstimate(d, 4)).toBe("");
    });

    it("stays unknown without any event, and for the other trackable statuses", () => {
      expect(isToday(makeDelivery(), 4)).toBe(false);
      expect(isToday(makeDelivery({ events: [{ event: "Scanned" }] }), 4)).toBe(false);
      // Status 2 with a scan from today is NOT out for delivery — no day is implied.
      expect(isToday(makeDelivery({ events: [{ date: "2026-06-15 07:12:00" }] }), 2)).toBe(false);
    });

    it("an expected date still wins over the scan day", () => {
      const d = makeDelivery({
        date_expected: "2026-06-16",
        events: [{ date: "2026-06-15 07:12:00" }],
      });
      expect(calculateDeliveryEstimate(d, 4)).toBe("tomorrow");
    });
  });
});

describe("timestamps in milliseconds (audit O9)", () => {
  const msOf = (d: Date): number => d.getTime();

  it("a millisecond value is drift — no window, no estimate, one line", () => {
    const log = makeLog();
    const d = makeDelivery({ timestamp_expected: msOf(new Date(2026, 5, 15, 9, 0, 0)) });
    expect(windowBoundsMs(d, 2, log)).toBeNull();
    expect(calculateDeliveryEstimate(d, 2, log)).toBe("");
    expect(log.lines.join()).toContain("timestamp_expected");
    expect(log.lines.join()).toContain("is milliseconds");
  });

  it("the date string still counts when the timestamp is unusable", () => {
    const d = makeDelivery({ timestamp_expected: msOf(new Date(2026, 5, 15, 9, 0, 0)), date_expected: "2026-06-16" });
    expect(calculateDeliveryEstimate(d, 2)).toBe("tomorrow");
  });

  it("the end timestamp gets the same check", () => {
    const log = makeLog();
    const start = Math.floor(new Date(2026, 5, 15, 9, 0, 0).getTime() / 1000);
    const d = makeDelivery({ timestamp_expected: start, timestamp_expected_end: msOf(new Date(2026, 5, 15, 13, 0)) });
    expect(calculateDeliveryWindow(d, 2, log)).toBe("09:00");
    expect(log.lines.join()).toContain("timestamp_expected_end");
  });
});

describe("expected day range (audit B1)", () => {
  const sec = (d: Date): number => Math.floor(d.getTime() / 1000);

  it("a range from yesterday to tomorrow is today — as midnight strings", () => {
    const d = makeDelivery({ date_expected: "2026-06-14 00:00:00", date_expected_end: "2026-06-16 00:00:00" });
    expect(calculateDeliveryEstimate(d, 2)).toBe("today");
    expect(isToday(d, 2)).toBe(true);
  });

  it("a range from yesterday to tomorrow is today — as timestamps", () => {
    const d = makeDelivery({
      timestamp_expected: sec(new Date(2026, 5, 14, 0, 0, 0)),
      timestamp_expected_end: sec(new Date(2026, 5, 16, 0, 0, 0)),
    });
    expect(calculateDeliveryEstimate(d, 2)).toBe("today");
    expect(isToday(d, 2)).toBe(true);
  });

  it("a range with times of day across today is today", () => {
    const d = makeDelivery({ date_expected: "2026-06-14 09:00:00", date_expected_end: "2026-06-16 18:00:00" });
    expect(isToday(d, 2)).toBe(true);
  });

  it("a range that ended yesterday is overdue, one that starts later counts to its start", () => {
    expect(
      calculateDeliveryEstimate(makeDelivery({ date_expected: "2026-06-12", date_expected_end: "2026-06-14" }), 2),
    ).toBe("overdue");
    expect(
      calculateDeliveryEstimate(makeDelivery({ date_expected: "2026-06-17", date_expected_end: "2026-06-19" }), 2),
    ).toBe("in 2 days");
  });

  it("an end at midnight after a timed start closes the day before", () => {
    const d = makeDelivery({ date_expected: "2026-06-14 20:00:00", date_expected_end: "2026-06-15 00:00:00" });
    expect(calculateDeliveryEstimate(d, 2)).toBe("overdue");
  });

  it("a day range that starts at midnight keeps its last day", () => {
    const range = expectedDayRange(makeDelivery({ date_expected: "2026-06-15", date_expected_end: "2026-06-16" }));
    expect(range).toEqual({
      startDay: new Date(2026, 5, 15).getTime(),
      endDay: new Date(2026, 5, 16).getTime(),
    });
  });

  it("an end before the start, or none, leaves just the start day", () => {
    const d = makeDelivery({ date_expected: "2026-06-16", date_expected_end: "2026-06-14" });
    expect(calculateDeliveryEstimate(d, 2)).toBe("tomorrow");
    expect(isToday(makeDelivery({ date_expected: "2026-06-15", date_expected_end: "2026-06-14" }), 2)).toBe(true);
    expect(expectedDayRange(makeDelivery({ date_expected: "2026-06-16" }))).toEqual({
      startDay: new Date(2026, 5, 16).getTime(),
      endDay: new Date(2026, 5, 16).getTime(),
    });
  });

  it("the end string counts when the end timestamp is missing", () => {
    const d = makeDelivery({ timestamp_expected: sec(new Date(2026, 5, 14, 9, 0)), date_expected_end: "2026-06-16" });
    expect(isToday(d, 2)).toBe(true);
  });
});

describe('"out for delivery" with a past date and a scan today (audit B3)', () => {
  const sec = (d: Date): number => Math.floor(d.getTime() / 1000);

  it("counts as today — date string", () => {
    const d = makeDelivery({ date_expected: "2026-06-14", events: [{ date: "2026-06-15 07:12:00" }] });
    expect(calculateDeliveryEstimate(d, 4)).toBe("today");
    expect(isToday(d, 4)).toBe(true);
  });

  it("counts as today — timestamp", () => {
    const d = makeDelivery({
      timestamp_expected: sec(new Date(2026, 5, 14, 10, 0)),
      events: [{ date: "Monday, 15 June 7:12 am" }],
    });
    expect(isToday(d, 4)).toBe(true);
  });

  it("stays overdue with an old scan, and for every other status", () => {
    expect(
      calculateDeliveryEstimate(
        makeDelivery({ date_expected: "2026-06-14", events: [{ date: "2026-06-14 07:12:00" }] }),
        4,
      ),
    ).toBe("overdue");
    expect(
      calculateDeliveryEstimate(
        makeDelivery({ date_expected: "2026-06-14", events: [{ date: "2026-06-15 07:12:00" }] }),
        2,
      ),
    ).toBe("overdue");
  });
});

describe("event dates (audit B2, O11)", () => {
  // FIXED_NOW is Monday, 15 June 2026. Every form below is one seen in a public recording of the
  // API (2026-09-25 audit §0), moved to that day.
  const todayForms = [
    "Monday, 15 June 1:21 am",
    "Monday, 15 June",
    "Monday, June 15 1:31 PM",
    "Monday, June 15 ",
    "Monday, June 15 1:31 pm",
    "Montag, 15. Juni 5:50",
    "segunda-feira 15 junho 11:23 PM",
    "segunda-feira 15 junho",
    "June 15, 2026 13:31",
    "06.15.2026 13:31",
    "06.15.2026",
    "15.06.2026 08:00",
    "2026-06-15 07:12:00",
    "lunes, 15 de junio",
    "dilluns, 15 de juny",
    "poniedziałek, 15 czerwca 10:00",
    "понедельник, 15 июня",
    "maandag 15 juni",
  ];
  for (const form of todayForms) {
    it(`reads '${form}' as today`, () => {
      const log = makeLog();
      expect(eventIsToday(form, log)).toBe(true);
      expect(log.lines).toEqual([]);
    });
  }

  it("a readable date that is not today is silent", () => {
    const log = makeLog();
    expect(eventIsToday("Sunday, 14 June 9:00 am", log)).toBe(false);
    expect(eventIsToday("06.14.2026 13:31", log)).toBe(false);
    expect(eventIsToday("2026-06-14 07:12:00", log)).toBe(false);
    expect(log.lines).toEqual([]);
  });

  it("the right day under the wrong weekday is not today", () => {
    const log = makeLog();
    expect(eventIsToday("Tuesday, 15 June", log)).toBe(false);
    expect(log.lines).toEqual([]);
  });

  it("a dotted date whose day and month cannot be told apart is not guessed", () => {
    const log = makeLog();
    expect(eventIsToday("06.06.2026", log)).toBe(false); // equal parts are unambiguous, just not today
    expect(eventIsToday("09.05.2026", log)).toBe(false);
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toContain("ambiguous dotted date '09.05.2026'");
  });

  it("an impossible dotted date is reported", () => {
    const log = makeLog();
    expect(eventIsToday("13.13.2026", log)).toBe(false);
    expect(eventIsToday("02.30.2026", log)).toBe(false);
    expect(log.lines.join()).toContain("month/day out of range");
    expect(log.lines.join()).toContain("not a real calendar date");
  });

  it("a form nobody reads leaves a drift line", () => {
    const log = makeLog();
    expect(eventIsToday("15/06/2026", log)).toBe(false);
    expect(eventIsToday("Mon, Jun 15", log)).toBe(false);
    expect(eventIsToday("6月15日", log)).toBe(false);
    expect(eventIsToday("Blursday, 15 June", log)).toBe(false);
    expect(log.lines).toHaveLength(4);
    expect(log.lines.every(l => l.startsWith("event-date drift: unsupported format"))).toBe(true);
  });

  it("an out-of-range time is not today", () => {
    const log = makeLog();
    expect(eventIsToday("2026-06-15 25:00:00", log)).toBe(false);
    expect(eventIsToday("Monday, 15 June 13:10 pm", log)).toBe(false);
    expect(eventIsToday("Monday, 15 June 7:61", log)).toBe(false);
    expect(eventIsToday("Monday, 32 June", log)).toBe(false);
    expect(log.lines).toHaveLength(4);
  });

  it("a missing date is silent, a wrong-typed one is reported", () => {
    const log = makeLog();
    expect(eventIsToday(undefined, log)).toBe(false);
    expect(eventIsToday(null, log)).toBe(false);
    expect(eventIsToday("  ", log)).toBe(false);
    expect(isToday(makeDelivery({ events: [{ event: "Scanned" }] }), 4, log)).toBe(false);
    expect(log.lines).toEqual([]);
    expect(eventIsToday(42, log)).toBe(false);
    expect(log.lines).toEqual(["event-date drift: not a string (got number)"]);
  });

  it("a name that means two months in two languages is dropped, not guessed", () => {
    // Czech "listopad" is November, Croatian "listopad" is October. No such pair exists among the app
    // languages today (measured 2026-09-25) — the guard is for the runtime's next locale data.
    const { months } = buildNameTables(["cs", "hr"]);
    expect(months.has("listopad")).toBe(false);
    expect(months.get("leden")).toBe(0);
    const app = buildNameTables();
    expect(app.months.get("września")).toBe(8);
    expect(app.months.get("setembre")).toBe(8);
    expect(app.weekdays.get("freitag")).toBe(5);
  });

  it("status 4 without an expected date takes the weekday form of the scan", () => {
    const d = makeDelivery({ events: [{ event: "Zustellung heute", date: "Montag, 15. Juni 5:50" }] });
    expect(calculateDeliveryEstimate(d, 4)).toBe("today");
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

  it("leaves out the stale window of a parcel that counts as today by its scan (audit X15)", () => {
    const entries = [
      {
        delivery: makeDelivery({
          date_expected: "2026-06-14 09:00:00",
          date_expected_end: "2026-06-14 13:00:00",
          events: [{ date: "2026-06-15 07:12:00" }],
        }),
        statusCode: 4,
      },
      {
        delivery: makeDelivery({ date_expected: "2026-06-15 10:00:00", date_expected_end: "2026-06-15 12:00:00" }),
        statusCode: 2,
      },
    ];
    expect(isToday(entries[0].delivery, 4)).toBe(true);
    expect(calculateCombinedWindow(entries)).toBe("10:00 - 12:00");
    expect(calculateCombinedWindow([entries[0]])).toBe("");
  });

  it("keeps a range that runs from yesterday into today", () => {
    const entries = [
      {
        delivery: makeDelivery({ date_expected: "2026-06-14 18:00:00", date_expected_end: "2026-06-15 12:00:00" }),
        statusCode: 2,
      },
    ];
    expect(calculateCombinedWindow(entries)).toBe("06-14 18:00 - 06-15 12:00");
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
