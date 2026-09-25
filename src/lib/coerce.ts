/**
 * Boundary coercion helpers for external API data.
 *
 * The parcel.app API is documented but field types still drift in practice
 * (rare success-flag returned as `"true"` string, occasional null where a
 * number is expected). These helpers guard against NaN/Infinity/non-string
 * values reaching ioBroker states.
 */

// Strict decimal regex — only optional minus sign + digits + optional fractional part.
// Rejects HEX (`0x...`), exponential (`1e3`), Infinity, NaN, leading/trailing whitespace.
// Hassemu (E8 in v1.9.0) hardened the same coerce-helper this way; homewizard
// adopted it in v0.7.2 (D8). Consistent with both adapters.
const DECIMAL_NUMBER_RE = /^-?\d+(\.\d+)?$/;

/**
 * Coerce to a finite number or null.
 * Accepts numbers directly; parses strict decimal strings; rejects NaN, Infinity,
 * HEX (`0x...`) and exponential notation (`1e3`).
 *
 * @param value Unknown external value
 */
export function coerceFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && DECIMAL_NUMBER_RE.test(value)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Coerce a parcel.app `success` flag. The API returns a real boolean in normal
 * operation, but the guard accepts common string/number encodings (`1`, `"true"`,
 * `"1"`) so a one-off drift doesn't break the entire poll cycle.
 *
 * @param v Value to interpret as a success flag
 */
export function isTrueish(v: unknown): boolean {
  if (typeof v === "boolean") {
    return v;
  }
  if (typeof v === "number") {
    return v === 1;
  }
  if (typeof v === "string") {
    const s = v.toLowerCase();
    return s === "true" || s === "1";
  }
  return false;
}

/**
 * One readable line for anything a `catch` receives — never `[object Object]`, never without the reason.
 * Fleet master form (`Entwicklung/CLAUDE_PATTERNS.md`, Async-Handler Error-Handling); the package checks
 * `error-text-reason` and `caught-value-text` hold every repository to it.
 *
 * @param err Caught value of unknown shape (Error, string, undefined, ...).
 * @returns the text
 */
export function errText(err: unknown): string {
  // It runs inside a `catch` and must not throw there: any property of a caught value can be a
  // getter that throws, or hold something other than a string.
  try {
    if (err instanceof Error) {
      // An empty message carries its reason in `code`: `http.get`/`net.connect` to `localhost`
      // reject with an AggregateError (message "", code ECONNREFUSED).
      const code = "code" in err ? err.code : undefined;
      const message: unknown = err.message;
      const name: unknown = err.name;
      const text = String(message || (typeof code === "string" ? code : name));
      // `fetch` rejects with TypeError("fetch failed", { cause }) — ENOTFOUND, ECONNREFUSED,
      // "other side closed" live only in the cause. One level, never the chain (`e.cause = e` is legal).
      const cause = err.cause;
      let reason = "";
      if (cause instanceof Error) {
        const causeCode = "code" in cause ? cause.code : undefined;
        const causeMessage: unknown = cause.message;
        reason =
          (typeof causeMessage === "string" ? causeMessage : "") || (typeof causeCode === "string" ? causeCode : "");
      } else if (cause !== undefined && cause !== null) {
        reason = errText(cause);
      }
      // A wrapper that copies its cause's message would say it twice.
      return reason && !text.includes(reason) ? `${text} (${reason})` : text;
    }
    if (typeof err === "string") {
      return err;
    }
    if (typeof err === "function") {
      // A thrown function or class: `String()` would print its whole source text.
      return Object.prototype.toString.call(err);
    }
    if (err === null || err === undefined || typeof err !== "object") {
      return String(err); // number, boolean, bigint, symbol (`${symbol}` would throw)
    }
    // A thrown object ({ code: "ECONNRESET" }, an HTTP client's error object): JSON.stringify
    // yields `undefined` for what it cannot render and throws on a circular structure.
    return JSON.stringify(err) ?? Object.prototype.toString.call(err);
  } catch {
    // A getter that threw, a circular structure for JSON.stringify: the type tag.
    return Object.prototype.toString.call(err);
  }
}

/**
 * v0.4.2 (X5): coerce an admin-config integer setting (number-or-string)
 * to a finite, clamped integer. Returns `defaultValue` for non-finite
 * input — guards against `setInterval(fn, NaN)` tight-loops when the
 * config field happens to come back as a string from the admin UI.
 *
 * @param raw Raw value from `this.config.<field>`.
 * @param min Inclusive lower bound.
 * @param max Inclusive upper bound.
 * @param defaultValue Fallback when raw is missing or unparseable.
 */
export function coerceClampedInt(raw: unknown, min: number, max: number, defaultValue: number): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? parseFloat(raw) : NaN;
  if (!Number.isFinite(n)) {
    return defaultValue;
  }
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/**
 * Collapse control-character runs in an untrusted string to a single space
 * before it is interpolated into a log line — prevents log-injection (a forged
 * second log line) and smuggled terminal escapes from external values
 * (tracking number, carrier code, raw API body, collision raw-key with its NUL
 * separator, …). Covers the whole C0 range (CR/LF/TAB/NUL/VT/FF, ESC, …), DEL
 * and the Unicode line separators U+2028/U+2029. Fleet convention (hassemu /
 * hueemu); widened from the line-break set in v0.10.0 (I10) to the full range
 * in 0.10.4 — as a character loop, because a regex literal with control
 * characters is rejected by the lint (no-control-regex).
 *
 * @param value Untrusted string to flatten for single-line logging.
 */
export function oneLine(value: string): string {
  let out = "";
  let inRun = false;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) {
      if (!inRun) {
        out += " ";
        inRun = true;
      }
    } else {
      out += ch;
      inRun = false;
    }
  }
  return out;
}
