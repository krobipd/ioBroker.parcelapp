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
 * Extract a log-friendly message from a thrown / rejected value. Centralizes the
 * `err instanceof Error ? err.message : String(err)` pattern that otherwise
 * gets repeated at every catch-site. Plain objects are JSON-stringified so a
 * `[object Object]` log is avoided when callers throw bag-of-fields.
 *
 * @param err Caught value of unknown shape (Error, string, undefined, ...).
 */
export function errText(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (err === null) {
    return "null";
  }
  if (err === undefined) {
    return "undefined";
  }
  if (typeof err === "string") {
    return err;
  }
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
    return String(err);
  }
  if (typeof err === "symbol") {
    // JSON.stringify(Symbol()) returns undefined (it does NOT throw), so the
    // catch below would never run and the declared `string` return would be a
    // lie. String(symbol) is the only safe conversion — `${symbol}` throws.
    return String(err);
  }
  // Plain objects would otherwise stringify to "[object Object]". Prefer JSON so
  // the log is at least diagnosable; circular structures fall back to the tag.
  try {
    // A function, or an object whose toJSON drops everything, also yields
    // undefined here — fall back rather than returning a non-string.
    return JSON.stringify(err) ?? Object.prototype.toString.call(err);
  } catch {
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
