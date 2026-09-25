/**
 * Everything that turns a raw parcel.app delivery into the strings the datapoints show:
 * the expected-delivery window, the human-readable estimate and the latest tracking event.
 *
 * Split out of `StateManager` in v0.12.0 (audit A1). The class had two reasons to change —
 * "parcel.app reports a new date format" and "ioBroker writes objects differently" — and only the
 * second one has anything to do with the broker. Nothing here touches the adapter or the object
 * DB; the only outside contact is the optional drift logger and the i18n lookup for the estimate
 * wording.
 */
import { coerceFiniteNumber, LOG_SNIPPET_LEN, oneLine } from "./coerce";
import { tText } from "./i18n";
import type { ParcelDelivery, ParcelEvent } from "./types";

/** Status codes that have an expected delivery date/time: 2=In Transit, 4=Out for Delivery, 8=Info Received */
export const TRACKABLE_STATUSES = new Set([2, 4, 8]);

/** "Out for Delivery" — the carrier has the parcel on the van. */
const OUT_FOR_DELIVERY = 4;

/**
 * Optional trace sink. Every parse that gives up says why — the adapter logs API drift everywhere
 * else (`parseStatus`, carrier lookup, response shape), and this was the one place that stayed
 * silent. An empty `deliveryWindow` with no log line is exactly what made the v0.8.0 window bug
 * hard to find (audit B2).
 */
export interface DriftLogger {
  /** Adapter debug log. One line per value that could not be parsed. */
  debug(message: string): void;
}

/**
 * Full English month names, lower-cased → 0-based month index. Only complete names are accepted:
 * an abbreviation would invite the ambiguity this parser deliberately refuses elsewhere.
 */
const MONTH_NAMES: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

/** `YYYY-MM-DD`, optionally followed by `HH:MM[:SS]` after a space or `T`. The documented default. */
const ISO_LIKE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
/** `Month D, YYYY`, optionally followed by `H:MM[:SS]`. Unambiguous — the month is spelled out. */
const MONTH_NAME_RE = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

/** Date/time components pulled out of a raw string before they are range-checked. */
interface DateParts {
  year: number;
  /** 0-based, like `Date`. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** Whether the string carried a clock at all (midnight still counts as "no time of day"). */
  hasClock: boolean;
}

/**
 * Pull the calendar components out of a raw string, without judging their ranges.
 *
 * Two formats are accepted, both unambiguous. The dotted (`dd.MM.yyyy` vs `MM.dd.yyyy`) and
 * weekday-only forms other clients guess at are deliberately NOT parsed — a wrong date is worse
 * than none. They now leave a drift line instead of vanishing silently.
 *
 * @param raw Trimmed date/time string from the API
 * @returns the components, or null when neither format matches
 */
function matchDateParts(raw: string): DateParts | null {
  const iso = ISO_LIKE_RE.exec(raw);
  if (iso) {
    return {
      year: Number(iso[1]),
      month: Number(iso[2]) - 1,
      day: Number(iso[3]),
      hour: iso[4] !== undefined ? Number(iso[4]) : 0,
      minute: iso[5] !== undefined ? Number(iso[5]) : 0,
      second: iso[6] !== undefined ? Number(iso[6]) : 0,
      hasClock: iso[4] !== undefined,
    };
  }
  const named = MONTH_NAME_RE.exec(raw);
  if (named) {
    const month = MONTH_NAMES[named[1].toLowerCase()];
    if (month === undefined) {
      return null;
    }
    return {
      year: Number(named[3]),
      month,
      day: Number(named[2]),
      hour: named[4] !== undefined ? Number(named[4]) : 0,
      minute: named[5] !== undefined ? Number(named[5]) : 0,
      second: named[6] !== undefined ? Number(named[6]) : 0,
      hasClock: named[4] !== undefined,
    };
  }
  return null;
}

/**
 * An untrusted date value as it may appear in a drift line: one line, bounded length. The value
 * comes straight from the carrier via parcel.app — a line break in it would forge a second log line.
 *
 * @param raw The rejected value
 * @returns the value flattened and capped for a log line
 */
function quoteForLog(raw: string): string {
  return oneLine(raw).slice(0, LOG_SNIPPET_LEN);
}

/**
 * Parse a parcel.app expected-date string to LOCAL epoch-millis.
 *
 * The API delivers `date_expected`/`date_expected_end` "without specific timezone information";
 * the components are applied to the local calendar so the value lands on the intended local
 * day/time (`new Date("YYYY-MM-DD")` would be UTC midnight). `hasTime` is false for a bare date or
 * a midnight time (a day, not an hour-window).
 *
 * @param value Raw date/time string from the API
 * @param log Optional trace sink — every rejected value leaves one line
 * @returns epoch millis plus whether a real time of day was given, or null when unparseable
 */
export function parseExpectedToMs(value: unknown, log?: DriftLogger): { ms: number; hasTime: boolean } | null {
  if (typeof value !== "string") {
    // undefined is the normal "carrier reports nothing" case and must stay quiet; anything else
    // present but wrong-typed is drift worth seeing.
    if (value !== undefined && value !== null) {
      log?.debug(`expected-date drift: not a string (got ${typeof value})`);
    }
    return null;
  }
  const raw = value.trim();
  if (raw.length === 0) {
    return null;
  }
  const parts = matchDateParts(raw);
  if (!parts) {
    log?.debug(`expected-date drift: unsupported format '${quoteForLog(raw)}' — no window/estimate for this package`);
    return null;
  }
  // Range-validate the components. The patterns only check digit COUNT, not value range, and
  // `new Date(2026, 12, 40, 25, …)` silently ROLLS OVER to a wrong date (getTime() is NOT NaN).
  if (parts.month < 0 || parts.month > 11 || parts.day < 1 || parts.day > 31) {
    log?.debug(`expected-date drift: month/day out of range in '${quoteForLog(raw)}'`);
    return null;
  }
  if (parts.hour > 23 || parts.minute > 59 || parts.second > 59) {
    log?.debug(`expected-date drift: time out of range in '${quoteForLog(raw)}'`);
    return null;
  }
  const date = new Date(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second);
  // Catch day-of-month overflow the range check misses (Feb 30, Apr 31, …): a real date
  // round-trips the month and day it was built from.
  if (Number.isNaN(date.getTime()) || date.getMonth() !== parts.month || date.getDate() !== parts.day) {
    log?.debug(`expected-date drift: '${quoteForLog(raw)}' is not a real calendar date`);
    return null;
  }
  const hasTime = parts.hasClock && !(parts.hour === 0 && parts.minute === 0 && parts.second === 0);
  return { ms: date.getTime(), hasTime };
}

/**
 * Resolve a delivery's expected window to epoch-millis bounds. Returns null for a non-trackable
 * status or when there is no usable start time.
 *
 * Prefers the Unix timestamp fields; for carriers that report the window only as a date/time
 * string it falls back to those — but only when the string carries a real time of day (a bare date
 * or midnight is a day, not an hour-window). Carrier-agnostic.
 *
 * @param delivery The delivery data
 * @param statusCode Pre-parsed status code
 * @param log Optional trace sink for unparseable dates
 * @returns window bounds in epoch millis, or null
 */
export function windowBoundsMs(
  delivery: ParcelDelivery,
  statusCode: number,
  log?: DriftLogger,
): { start: number; end: number | null } | null {
  if (!TRACKABLE_STATUSES.has(statusCode)) {
    return null;
  }
  const toMs = (timestamp: unknown): number | null => {
    const ts = coerceFiniteNumber(timestamp);
    if (ts === null || ts <= 0) {
      return null;
    }
    const ms = ts * 1000;
    return Number.isNaN(new Date(ms).getTime()) ? null : ms;
  };
  const dateMs = (value: unknown): number | null => {
    const parsed = parseExpectedToMs(value, log);
    return parsed && parsed.hasTime ? parsed.ms : null;
  };
  const start = toMs(delivery.timestamp_expected) ?? dateMs(delivery.date_expected);
  if (start === null) {
    return null;
  }
  const end = toMs(delivery.timestamp_expected_end) ?? dateMs(delivery.date_expected_end);
  return { start, end };
}

/**
 * Format epoch-millis as local HH:MM.
 *
 * @param ms Epoch milliseconds
 * @returns `HH:MM`
 */
function formatHHMM(ms: number): string {
  const d = new Date(ms);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

/**
 * Local "MM-DD HH:MM" — used when a window spans more than one calendar day.
 *
 * @param ms Epoch milliseconds
 * @returns `MM-DD HH:MM`
 */
function formatDateHHMM(ms: number): string {
  const d = new Date(ms);
  const mm = (d.getMonth() + 1).toString().padStart(2, "0");
  const dd = d.getDate().toString().padStart(2, "0");
  return `${mm}-${dd} ${formatHHMM(ms)}`;
}

/**
 * Whether two epoch-millis fall on the same LOCAL calendar day.
 *
 * @param aMs First epoch milliseconds
 * @param bMs Second epoch milliseconds
 * @returns true when both are the same local day
 */
function sameLocalDay(aMs: number, bMs: number): boolean {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * Format a start→end window as a local string. A real end (> start) on the SAME day renders
 * "HH:MM - HH:MM"; an end on a LATER day carries the date on both sides ("12-06 14:30 - 12-08
 * 18:30") so a multi-day window is not shown as if it were same-day. No end, or an end <= start
 * (reversed/equal), renders just the start.
 *
 * @param startMs Window start (epoch ms)
 * @param endMs Window end (epoch ms) or null
 * @returns the formatted window
 */
export function formatWindow(startMs: number, endMs: number | null): string {
  if (endMs === null || endMs <= startMs) {
    return formatHHMM(startMs);
  }
  return sameLocalDay(startMs, endMs)
    ? `${formatHHMM(startMs)} - ${formatHHMM(endMs)}`
    : `${formatDateHHMM(startMs)} - ${formatDateHHMM(endMs)}`;
}

/**
 * Calculate a delivery time-window string from the resolved expected bounds.
 *
 * @param delivery The delivery data
 * @param statusCode Pre-parsed status code
 * @param log Optional trace sink for unparseable dates
 * @returns the window string, or "" when there is none
 */
export function calculateDeliveryWindow(delivery: ParcelDelivery, statusCode: number, log?: DriftLogger): string {
  const bounds = windowBoundsMs(delivery, statusCode, log);
  if (!bounds) {
    return "";
  }
  return formatWindow(bounds.start, bounds.end);
}

/**
 * Days from today to the expected delivery date. Returns null when the delivery has no usable
 * expected date or is in a non-trackable status.
 *
 * @param delivery The delivery data
 * @param statusCode Pre-parsed status code
 * @param log Optional trace sink for unparseable dates
 * @returns whole days from today, or null
 */
export function computeDiffDays(delivery: ParcelDelivery, statusCode: number, log?: DriftLogger): number | null {
  if (!TRACKABLE_STATUSES.has(statusCode)) {
    return null;
  }

  let expectedDate: Date | null = null;
  const ts = coerceFiniteNumber(delivery.timestamp_expected);
  if (ts !== null && ts > 0) {
    expectedDate = new Date(ts * 1000);
  } else {
    // Shares the window's date parser (one source of format-truth). Only the calendar day matters
    // here, so the time-of-day flag is ignored; the local-component parse keeps the day
    // timezone-stable.
    const parsed = parseExpectedToMs(delivery.date_expected, log);
    expectedDate = parsed ? new Date(parsed.ms) : null;
  }

  if (!expectedDate || Number.isNaN(expectedDate.getTime())) {
    // v0.13.0 (audit O1): plenty of carriers report "out for delivery" without any
    // expected date. The parcel is on the van, but it was missing from todayCount
    // and had no estimate. The day of the last scan decides: scanned today → today
    // (the window stays empty, there is no time to show); an older scan is not
    // evidence for today, so it stays unknown.
    if (statusCode === OUT_FOR_DELIVERY) {
      const scanned = parseExpectedToMs(getLatestEvent(delivery)?.date, log);
      if (scanned) {
        const scanDate = new Date(scanned.ms);
        const scanStart = new Date(scanDate.getFullYear(), scanDate.getMonth(), scanDate.getDate());
        const nowForScan = new Date();
        const todayForScan = new Date(nowForScan.getFullYear(), nowForScan.getMonth(), nowForScan.getDate());
        if (scanStart.getTime() === todayForScan.getTime()) {
          return 0;
        }
      }
    }
    return null;
  }

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const expectedStart = new Date(expectedDate.getFullYear(), expectedDate.getMonth(), expectedDate.getDate());
  return Math.round((expectedStart.getTime() - todayStart.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Calculate the human-readable delivery estimate in the system language.
 *
 * @param delivery The delivery data
 * @param statusCode Pre-parsed status code
 * @param log Optional trace sink for unparseable dates
 * @returns the estimate wording, or "" when there is no usable date
 */
export function calculateDeliveryEstimate(delivery: ParcelDelivery, statusCode: number, log?: DriftLogger): string {
  const diffDays = computeDiffDays(delivery, statusCode, log);
  if (diffDays === null) {
    return "";
  }
  if (diffDays < 0) {
    return tText("estimateOverdue");
  }
  if (diffDays === 0) {
    return tText("estimateToday");
  }
  if (diffDays === 1) {
    return tText("estimateTomorrow");
  }
  return tText("estimateDays", diffDays);
}

/**
 * Whether the delivery is expected today. Language-agnostic, so the summary filter works in every
 * language.
 *
 * @param delivery The delivery data
 * @param statusCode Pre-parsed status code
 * @param log Optional trace sink for unparseable dates
 * @returns true when the expected date is today
 */
export function isToday(delivery: ParcelDelivery, statusCode: number, log?: DriftLogger): boolean {
  return computeDiffDays(delivery, statusCode, log) === 0;
}

/** A delivery together with its already-parsed status code — avoids re-parsing at every call site. */
export interface StatusedDelivery {
  /** The delivery data */
  delivery: ParcelDelivery;
  /** Pre-parsed status code */
  statusCode: number;
}

/**
 * Combined delivery window for today's packages: earliest start to latest end across all windows.
 * Computed from the raw millis (not the formatted strings) so the latest end always wins — fixes
 * the earlier bug where the end of the latest-*starting* window was used instead of the maximum
 * end.
 *
 * @param todayDeliveries Deliveries expected today, with their parsed status codes
 * @param log Optional trace sink for unparseable dates
 * @returns the combined window string, or "" when no package reports one
 */
export function calculateCombinedWindow(todayDeliveries: StatusedDelivery[], log?: DriftLogger): string {
  const bounds = todayDeliveries
    .map(e => windowBoundsMs(e.delivery, e.statusCode, log))
    .filter((b): b is { start: number; end: number | null } => b !== null);

  if (bounds.length === 0) {
    return "";
  }

  // L3: fold instead of Math.min/max(...spread). The bounds array is capped by the 1 MiB response
  // limit, but a spread over a large array can still hit V8's argument-count limit (RangeError);
  // reduce is O(n) and unbounded-safe — consistent with beszel's computeMaxTemp hardening.
  const minStart = bounds.reduce((m, b) => (b.start < m ? b.start : m), bounds[0].start);
  const maxEnd = bounds.reduce((m, b) => {
    const e = b.end ?? b.start;
    return e > m ? e : m;
  }, bounds[0].end ?? bounds[0].start);
  return formatWindow(minStart, maxEnd);
}

/**
 * Newest tracking event of a delivery — `events[0]`, confirmed across several parcel.app clients.
 *
 * @param delivery The delivery data
 * @returns the newest event, or null when there is none
 */
function getLatestEvent(delivery: ParcelDelivery): ParcelEvent | null {
  if (!Array.isArray(delivery.events) || delivery.events.length === 0) {
    return null;
  }
  const latest = delivery.events[0];
  if (!latest || typeof latest !== "object") {
    return null;
  }
  return latest;
}

/**
 * The newest tracking event as "<event> - <date>", dropping whichever half the carrier omitted.
 *
 * @param delivery The delivery data
 * @returns the formatted event, or "" when there is none
 */
export function formatLastEvent(delivery: ParcelDelivery): string {
  const latest = getLatestEvent(delivery);
  if (!latest) {
    return "";
  }
  const parts: string[] = [];
  if (typeof latest.event === "string" && latest.event.length > 0) {
    parts.push(latest.event);
  }
  if (typeof latest.date === "string" && latest.date.length > 0) {
    parts.push(latest.date);
  }
  return parts.join(" - ");
}

/**
 * Location of the newest tracking event.
 *
 * @param delivery The delivery data
 * @returns the location, or "" when the carrier reports none
 */
export function extractLastLocation(delivery: ParcelDelivery): string {
  const latest = getLatestEvent(delivery);
  if (!latest) {
    return "";
  }
  return typeof latest.location === "string" ? latest.location : "";
}
