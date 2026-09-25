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
/** `a.b.yyyy[ H:MM[:SS]]` — only read in tracking events, and only where day and month can be told apart. */
const DOTTED_RE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?: (\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
/**
 * The weekday form of tracking events, without a year: `Saturday, 6 December 1:21 am`,
 * `Tuesday, May 13 1:31 PM`, `Freitag, 25. September 5:50`, `domingo 24 agosto 11:23 PM`,
 * `domingo, 24 de agosto`. Weekday optional, day before or after the month name, a dot after the
 * day, the Spanish/Portuguese/Catalan `de`/`d'` before the month, a 12- or 24-hour clock. Applied to
 * the lower-cased, whitespace-collapsed string with every apostrophe folded to `'`.
 */
const WEEKDAY_FORM_RE =
  /^(?:([\p{L}'-]+)\.?,? )?(?:(\d{1,2})\.? (?:de |d')?([\p{L}'-]+)|([\p{L}'-]+) (\d{1,2})\.?)(?:,? (\d{1,2}):(\d{2})(?::(\d{2}))?(?: ?([ap])\.?m\.?)?)?$/u;

/** One local calendar day — only ever used to round the distance between two local midnights. */
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * A Unix timestamp in SECONDS above this lies beyond the year 5000 — such a value is milliseconds,
 * and multiplying it by 1000 again would put the delivery thousands of years ahead (audit O9).
 */
const MAX_EPOCH_SECONDS = 1e11;

/** The languages the parcel.app app ships in — the language of the event texts follows the delivery. */
const APP_LANGUAGES = ["en", "ca", "da", "nl", "fi", "fr", "de", "it", "ja", "pl", "pt", "ru", "es", "sv", "uk"];

/**
 * Lower-case a name the way the event parser compares it: every apostrophe variant becomes `'`.
 *
 * @param text Raw text
 * @returns the comparable form
 */
function foldName(text: string): string {
  return text.toLowerCase().replace(/[’ʼ]/g, "'");
}

/**
 * Month and weekday names of every app language, from the runtime's own locale data — the format
 * form (`września`, `de setembre`) and the standalone form (`wrzesień`, `setembre`). A name that
 * means different things in two languages would be a guess, so it is dropped; names that are not
 * words (the Japanese `9月`) never match the word pattern and are left out.
 *
 * @param languages Locales to read — the app languages; a test passes two that disagree
 * @returns name → 0-based month, name → 0-based weekday (0 = Sunday)
 */
export function buildNameTables(languages: readonly string[] = APP_LANGUAGES): {
  months: Map<string, number>;
  weekdays: Map<string, number>;
} {
  const collect = (entries: [string, number][]): Map<string, number> => {
    const seen = new Map<string, number>();
    const conflicting = new Set<string>();
    for (const [raw, index] of entries) {
      const name = foldName(raw).replace(/^(?:de |d')/, "");
      if (!/^[\p{L}'-]+$/u.test(name)) {
        continue;
      }
      const known = seen.get(name);
      if (known !== undefined && known !== index) {
        conflicting.add(name);
      }
      seen.set(name, index);
    }
    for (const name of conflicting) {
      seen.delete(name);
    }
    return seen;
  };
  const monthEntries: [string, number][] = [];
  const weekdayEntries: [string, number][] = [];
  for (const lang of languages) {
    const inContext = new Intl.DateTimeFormat(lang, { day: "numeric", month: "long" });
    const standalone = new Intl.DateTimeFormat(lang, { month: "long" });
    const weekday = new Intl.DateTimeFormat(lang, { weekday: "long" });
    for (let month = 0; month < 12; month++) {
      const date = new Date(2026, month, 15);
      const part = inContext.formatToParts(date).find(p => p.type === "month");
      if (part) {
        monthEntries.push([part.value, month]);
      }
      monthEntries.push([standalone.format(date), month]);
    }
    for (let day = 0; day < 7; day++) {
      // 2026-06-14 is a Sunday.
      const date = new Date(2026, 5, 14 + day);
      weekdayEntries.push([weekday.format(date), date.getDay()]);
    }
  }
  return { months: collect(monthEntries), weekdays: collect(weekdayEntries) };
}

let nameTables: ReturnType<typeof buildNameTables> | null = null;

/**
 * The name tables, built on first use — most polls never see a weekday-form date.
 *
 * @returns the month and weekday tables
 */
function getNameTables(): ReturnType<typeof buildNameTables> {
  nameTables ??= buildNameTables();
  return nameTables;
}

/** Why a raw date string was not accepted. */
type DateRejection = "format" | "range-date" | "range-time" | "calendar" | "ambiguous";

/** A parsed date: LOCAL epoch-millis, and whether it carried a real time of day. */
interface ParsedDate {
  ms: number;
  hasTime: boolean;
}

/**
 * Collapse every whitespace run to one space (audit X14). Lossless and unambiguous — a doubled
 * space between date and time must not cost a package its window.
 *
 * @param raw Raw string
 * @returns the trimmed, collapsed string
 */
function collapseWhitespace(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/**
 * Parse a date string with a YEAR, silently, with every component range-checked. The two accepted
 * forms are unambiguous; the reason for a rejection goes back to the caller, which decides whether
 * and how to report it.
 *
 * The components are applied to the local calendar so the value lands on the intended local
 * day/time (`new Date("YYYY-MM-DD")` would be UTC midnight). `hasTime` is false for a bare date or
 * a midnight time (a day, not an hour-window).
 *
 * @param raw Trimmed, whitespace-collapsed date/time string
 * @returns the parsed date, or the reason it was rejected
 */
function parseDateParts(raw: string): ParsedDate | { reason: DateRejection } {
  let parts: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    hasClock: boolean;
  };
  const iso = ISO_LIKE_RE.exec(raw);
  const named = iso ? null : MONTH_NAME_RE.exec(raw);
  if (iso) {
    parts = {
      year: Number(iso[1]),
      month: Number(iso[2]) - 1,
      day: Number(iso[3]),
      hour: iso[4] !== undefined ? Number(iso[4]) : 0,
      minute: iso[5] !== undefined ? Number(iso[5]) : 0,
      second: iso[6] !== undefined ? Number(iso[6]) : 0,
      hasClock: iso[4] !== undefined,
    };
  } else if (named) {
    const month = MONTH_NAMES[named[1].toLowerCase()];
    if (month === undefined) {
      return { reason: "format" };
    }
    parts = {
      year: Number(named[3]),
      month,
      day: Number(named[2]),
      hour: named[4] !== undefined ? Number(named[4]) : 0,
      minute: named[5] !== undefined ? Number(named[5]) : 0,
      second: named[6] !== undefined ? Number(named[6]) : 0,
      hasClock: named[4] !== undefined,
    };
  } else {
    return { reason: "format" };
  }
  // Range-validate the components. The patterns only check digit COUNT, not value range, and
  // `new Date(2026, 12, 40, 25, …)` silently ROLLS OVER to a wrong date (getTime() is NOT NaN).
  if (parts.month < 0 || parts.month > 11 || parts.day < 1 || parts.day > 31) {
    return { reason: "range-date" };
  }
  if (parts.hour > 23 || parts.minute > 59 || parts.second > 59) {
    return { reason: "range-time" };
  }
  const date = new Date(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second);
  // Catch day-of-month overflow the range check misses (Feb 30, Apr 31, …): a real date
  // round-trips the month and day it was built from.
  if (Number.isNaN(date.getTime()) || date.getMonth() !== parts.month || date.getDate() !== parts.day) {
    return { reason: "calendar" };
  }
  const hasTime = parts.hasClock && !(parts.hour === 0 && parts.minute === 0 && parts.second === 0);
  return { ms: date.getTime(), hasTime };
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
 * The drift wording for a rejected date — one text per reason, shared by both date fields.
 *
 * @param reason Why the value was rejected
 * @param raw The rejected value
 * @returns the reason as a log fragment
 */
function rejectionText(reason: DateRejection, raw: string): string {
  switch (reason) {
    case "range-date":
      return `month/day out of range in '${quoteForLog(raw)}'`;
    case "range-time":
      return `time out of range in '${quoteForLog(raw)}'`;
    case "calendar":
      return `'${quoteForLog(raw)}' is not a real calendar date`;
    case "ambiguous":
      return `ambiguous dotted date '${quoteForLog(raw)}' — day and month cannot be told apart`;
    default:
      return `unsupported format '${quoteForLog(raw)}'`;
  }
}

/**
 * Parse a parcel.app expected-date string to LOCAL epoch-millis.
 *
 * The API delivers `date_expected`/`date_expected_end` "without specific timezone information".
 * Only forms with a year are read here — every public recording of these two fields carries the
 * ISO form; the weekday and dotted forms other clients guess at were never seen in them, and
 * without a year the year would have to be guessed. They leave a drift line instead.
 *
 * @param value Raw date/time string from the API
 * @param log Optional trace sink — every rejected value leaves one line
 * @returns epoch millis plus whether a real time of day was given, or null when unparseable
 */
export function parseExpectedToMs(value: unknown, log?: DriftLogger): ParsedDate | null {
  if (typeof value !== "string") {
    // undefined is the normal "carrier reports nothing" case and must stay quiet; anything else
    // present but wrong-typed is drift worth seeing.
    if (value !== undefined && value !== null) {
      log?.debug(`expected-date drift: not a string (got ${typeof value})`);
    }
    return null;
  }
  const raw = collapseWhitespace(value);
  if (raw.length === 0) {
    return null;
  }
  const parsed = parseDateParts(raw);
  if ("reason" in parsed) {
    const hint = parsed.reason === "format" ? " — no window/estimate for this package" : "";
    log?.debug(`expected-date drift: ${rejectionText(parsed.reason, raw)}${hint}`);
    return null;
  }
  return parsed;
}

/**
 * Local midnight of the day an epoch-millis value falls on.
 *
 * @param ms Epoch milliseconds
 * @returns epoch milliseconds of that local day's start
 */
function localDayStart(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Read one of the Unix-timestamp fields (`timestamp_expected[_end]`, seconds) as epoch-millis.
 * One helper for the window and the day range, so both see the same value (audit O9).
 *
 * @param value Raw field value
 * @param field Field name for the drift line
 * @param log Optional trace sink
 * @returns epoch milliseconds, or null when the field is absent or unusable
 */
function epochSecondsToMs(value: unknown, field: string, log?: DriftLogger): number | null {
  const seconds = coerceFiniteNumber(value);
  if (seconds === null || seconds <= 0) {
    return null;
  }
  if (seconds > MAX_EPOCH_SECONDS) {
    log?.debug(`expected-date drift: ${field} ${seconds} is milliseconds, not seconds — ignored`);
    return null;
  }
  return seconds * 1000;
}

/**
 * Whether a tracking event's date is today. The event dates come in more shapes than the expected
 * date, and in the language of the delivery (§0 of the 2026-09-25 audit): the forms with a year,
 * the dotted form of UPS (`05.13.2025 13:31` — month first, read only where day and month can be
 * told apart) and the weekday form without a year in all app languages. A missing date is silent;
 * a date that is read but not today is silent too; a form nobody reads leaves a drift line.
 *
 * @param value Raw `events[].date`
 * @param log Optional trace sink
 * @returns true when the event happened today (local calendar)
 */
export function eventIsToday(value: unknown, log?: DriftLogger): boolean {
  if (typeof value !== "string") {
    if (value !== undefined && value !== null) {
      log?.debug(`event-date drift: not a string (got ${typeof value})`);
    }
    return false;
  }
  const raw = collapseWhitespace(value);
  if (raw.length === 0) {
    return false;
  }
  const now = new Date();
  const reject = (reason: DateRejection): boolean => {
    log?.debug(`event-date drift: ${rejectionText(reason, raw)}`);
    return false;
  };

  // 1. The forms with a year — the same range-checked parser as the expected date.
  const withYear = parseDateParts(raw);
  if (!("reason" in withYear)) {
    return sameLocalDay(withYear.ms, now.getTime());
  }
  if (withYear.reason !== "format") {
    return reject(withYear.reason);
  }

  // 2. The dotted form, only where it is unambiguous.
  const dotted = DOTTED_RE.exec(raw);
  if (dotted) {
    const a = Number(dotted[1]);
    const b = Number(dotted[2]);
    let month: number;
    let day: number;
    if (a === b || (a > 12 && b <= 12)) {
      [day, month] = [a, b];
    } else if (b > 12 && a <= 12) {
      [month, day] = [a, b];
    } else {
      return reject(a > 12 ? "range-date" : "ambiguous");
    }
    const pad = (n: number | string): string => String(n).padStart(2, "0");
    const clock = dotted[4] !== undefined ? ` ${pad(dotted[4])}:${dotted[5]}${dotted[6] ? `:${dotted[6]}` : ""}` : "";
    const rebuilt = parseDateParts(`${dotted[3]}-${pad(month)}-${pad(day)}${clock}`);
    return "reason" in rebuilt ? reject(rebuilt.reason) : sameLocalDay(rebuilt.ms, now.getTime());
  }

  // 3. The weekday form without a year.
  const form = WEEKDAY_FORM_RE.exec(foldName(raw));
  if (!form) {
    return reject("format");
  }
  const { months, weekdays } = getNameTables();
  const monthName = form[3] ?? form[4];
  const month = months.get(monthName);
  const weekday = form[1] !== undefined ? weekdays.get(form[1]) : null;
  if (month === undefined || weekday === undefined) {
    return reject("format");
  }
  const day = Number(form[2] ?? form[5]);
  if (day < 1 || day > 31) {
    return reject("range-date");
  }
  if (form[6] !== undefined) {
    const hour = Number(form[6]);
    const twelveHour = form[9] !== undefined;
    if ((twelveHour ? hour < 1 || hour > 12 : hour > 23) || Number(form[7]) > 59 || Number(form[8] ?? 0) > 59) {
      return reject("range-time");
    }
  }
  return month === now.getMonth() && day === now.getDate() && (weekday === null || weekday === now.getDay());
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
  const dateMs = (value: unknown): number | null => {
    const parsed = parseExpectedToMs(value, log);
    return parsed && parsed.hasTime ? parsed.ms : null;
  };
  const start =
    epochSecondsToMs(delivery.timestamp_expected, "timestamp_expected", log) ?? dateMs(delivery.date_expected);
  if (start === null) {
    return null;
  }
  const end =
    epochSecondsToMs(delivery.timestamp_expected_end, "timestamp_expected_end", log) ??
    dateMs(delivery.date_expected_end);
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
 * The local calendar days the delivery is expected on (audit B1). parcel.app reports a RANGE as
 * often as a single day — a start and an end, as timestamps or as date strings, often at midnight
 * (`2025-12-06 00:00:00` → `2025-12-08 00:00:00`). Unlike the window, a bare date or a midnight
 * counts here: it names a day.
 *
 * @param delivery The delivery data
 * @param log Optional trace sink for unparseable dates
 * @returns the local midnights of the first and the last expected day, or null without a start
 */
export function expectedDayRange(
  delivery: ParcelDelivery,
  log?: DriftLogger,
): { startDay: number; endDay: number } | null {
  const start =
    epochSecondsToMs(delivery.timestamp_expected, "timestamp_expected", log) ??
    parseExpectedToMs(delivery.date_expected, log)?.ms ??
    null;
  if (start === null) {
    return null;
  }
  const startDay = localDayStart(start);
  let end =
    epochSecondsToMs(delivery.timestamp_expected_end, "timestamp_expected_end", log) ??
    parseExpectedToMs(delivery.date_expected_end, log)?.ms ??
    null;
  if (end === null || end < start) {
    return { startDay, endDay: startDay };
  }
  // An end at exactly midnight after a start with a time of day closes the day before: a window
  // "20:00 until 00:00" is over when the next day begins.
  if (end > start && end === localDayStart(end) && start !== startDay) {
    end -= 1;
  }
  return { startDay, endDay: localDayStart(end) };
}

/**
 * Days from today to the expected delivery: positive before the first expected day, 0 on any day
 * of the range, negative (counted from the last day) after it. Null when the delivery has no usable
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
  const range = expectedDayRange(delivery, log);
  let diff: number | null = null;
  if (range) {
    const today = localDayStart(Date.now());
    if (today < range.startDay) {
      diff = Math.round((range.startDay - today) / DAY_MS);
    } else if (today > range.endDay) {
      diff = Math.round((range.endDay - today) / DAY_MS);
    } else {
      diff = 0;
    }
  }
  // v0.13.0 (audit O1), v0.14.0 (audit B3): "out for delivery" with no expected date — or with
  // one that already lies in the past — is today when the carrier scanned the parcel today. The
  // parcel is on the van; an old date only means the carrier did not update it. An older scan is no
  // evidence for today, so the diff stays what it was.
  if (statusCode === OUT_FOR_DELIVERY && (diff === null || diff < 0)) {
    if (eventIsToday(getLatestEvent(delivery)?.date, log)) {
      return 0;
    }
  }
  return diff;
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
  // v0.14.0 (audit 2026-09-25, X15): a package counts as today by its SCAN when its window already
  // lies in the past (out for delivery, stale date — B3). That old window is not today's; it must
  // not stretch the combined window back into yesterday.
  const todayStart = localDayStart(Date.now());
  const bounds = todayDeliveries
    .map(e => windowBoundsMs(e.delivery, e.statusCode, log))
    .filter((b): b is { start: number; end: number | null } => b !== null && (b.end ?? b.start) >= todayStart);

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
