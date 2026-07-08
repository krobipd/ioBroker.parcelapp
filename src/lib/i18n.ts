import { I18n } from "@iobroker/adapter-core";
import type translations from "../../admin/i18n/en.json";

type I18nKey = keyof typeof translations;

/**
 * @param key Translation key from admin/i18n/en.json
 */
export function tName(key: I18nKey): ioBroker.StringOrTranslated {
  return I18n.getTranslatedObject(key);
}

/**
 * Type-safe wrapper around I18n.translate — a typo'd key is a compile error,
 * matching the guarantee tName already gives object names (v0.10.0, L13).
 * `%s` placeholders are filled from args, rendered in the system language.
 *
 * @param key Translation key from admin/i18n/en.json
 * @param args Values substituted for `%s` placeholders
 */
export function tText(key: I18nKey, ...args: (string | number | boolean | null)[]): string {
  return I18n.translate(key, ...args);
}

/** status_code → i18n key. `satisfies` pins every entry to a real key in en.json. */
const STATUS_KEYS = {
  0: "status_0",
  1: "status_1",
  2: "status_2",
  3: "status_3",
  4: "status_4",
  5: "status_5",
  6: "status_6",
  7: "status_7",
  8: "status_8",
} as const satisfies Record<number, I18nKey>;

/**
 * Localized status label for a parsed status code, or undefined for codes the
 * table does not know (API drift) — the caller renders its own fallback.
 * Replaces the former STATUS_LABELS table in types.ts (v0.10.0, L20): one
 * translation system (admin/i18n via adapter-core I18n) instead of two.
 *
 * @param code Parsed numeric status code
 */
export function statusLabel(code: number): string | undefined {
  const key = (STATUS_KEYS as Partial<Record<number, I18nKey>>)[code];
  return key === undefined ? undefined : I18n.translate(key);
}

/**
 * Localized fallback device name ("Package <tracking>") as a translation
 * object — getTranslatedObject substitutes `%s` in every language, so the
 * one previously hard-English user-facing label is localized too (v0.10.0, L18).
 *
 * @param trackingNumber Tracking number (or package id) interpolated into the name
 */
export function packageName(trackingNumber: string): ioBroker.StringOrTranslated {
  return I18n.getTranslatedObject("packageName", trackingNumber);
}
