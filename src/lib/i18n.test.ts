import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const i18nDir = join(__dirname, "../../admin/i18n");
const files = readdirSync(i18nDir).filter(f => f.endsWith(".json"));
const i18nData: Record<string, Record<string, string>> = {};
for (const f of files) {
  i18nData[f.replace(".json", "")] = JSON.parse(readFileSync(join(i18nDir, f), "utf8"));
}
let mockLang = "en";

/**
 * Mirrors adapter-core's I18n against the REAL translation files, not against
 * the key names. The previous version echoed the key back, which made every
 * assertion below true no matter what the wrapper did with it: a test could not
 * tell "argument passed through" from "argument dropped", and the tracking
 * number in packageName never had to appear anywhere. Proven by mutation on
 * 2026-08-22 — dropping the `%s` args left this file entirely green.
 */
const fillArgs = (text: string, args: (string | number | boolean | null)[]): string => {
  for (const arg of args) {
    text = text.replace("%s", arg === null ? "null" : String(arg));
  }
  return text;
};
vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: vi.fn((key: string, ...args: (string | number | boolean | null)[]) => {
      const result: Record<string, string> = {};
      for (const [lang, data] of Object.entries(i18nData)) {
        result[lang] = fillArgs(data[key] ?? key, args);
      }
      return result;
    }),
    translate: vi.fn((key: string, ...args: (string | number | boolean | null)[]) =>
      fillArgs(i18nData[mockLang]?.[key] ?? i18nData.en?.[key] ?? key, args),
    ),
  },
}));

import { packageName, statusLabel, tName, tText } from "./i18n";

beforeEach(() => {
  mockLang = "en";
});

describe("tName", () => {
  it("returns the real translation object for the key, not the key itself", () => {
    const result = tName("carrier") as Record<string, string>;
    expect(result.en).toBe(i18nData.en.carrier);
    expect(result.de).toBe(i18nData.de.carrier);
    // The two languages really differ — a wrapper that collapsed everything to
    // one language would pass a same-value check.
    expect(result.de).not.toBe(result.en);
  });

  it("covers every shipped language, not just en/de", () => {
    const result = tName("status") as Record<string, string>;
    for (const lang of Object.keys(i18nData)) {
      expect(result[lang], `missing ${lang}`).toBe(i18nData[lang].status);
    }
  });
});

describe("tText (v0.10.0, L13)", () => {
  it("renders in the current system language", () => {
    mockLang = "de";
    expect(tText("estimateToday")).toBe(i18nData.de.estimateToday);
    mockLang = "fr";
    expect(tText("estimateToday")).toBe(i18nData.fr.estimateToday);
  });

  it("substitutes %s arguments — the key it uses really carries a placeholder", () => {
    expect(i18nData.en.estimateDays, "test premise: estimateDays must contain %s").toContain("%s");
    const rendered = tText("estimateDays", 3);
    expect(rendered).toBe(i18nData.en.estimateDays.replace("%s", "3"));
    expect(rendered).not.toContain("%s"); // the placeholder is gone, i.e. filled
    expect(rendered).toContain("3");
  });
});

describe("statusLabel (v0.10.0, L20)", () => {
  it("resolves status codes 0-8 to their translated label", () => {
    mockLang = "de";
    for (let code = 0; code <= 8; code++) {
      expect(statusLabel(code), `code ${code}`).toBe(i18nData.de[`status_${code}`]);
    }
  });

  it("returns undefined for unknown codes so the caller renders its own fallback", () => {
    // -1 is the drift sentinel (UNKNOWN_STATUS_CODE), 9/42 are future codes.
    expect(statusLabel(-1)).toBeUndefined();
    expect(statusLabel(9)).toBeUndefined();
    expect(statusLabel(42)).toBeUndefined();
  });
});

describe("packageName (v0.10.0, L18)", () => {
  it("interpolates the tracking number into EVERY language", () => {
    const result = packageName("TRK9") as Record<string, string>;
    for (const lang of Object.keys(i18nData)) {
      expect(result[lang], `${lang} must carry the tracking number`).toContain("TRK9");
      expect(result[lang], `${lang} must not keep the raw placeholder`).not.toContain("%s");
      expect(result[lang]).toBe(i18nData[lang].packageName.replace("%s", "TRK9"));
    }
  });
});

describe("i18n completeness", () => {
  const enKeys = [...Object.keys(i18nData.en)].sort();

  it("ships all 11 ioBroker languages", () => {
    expect(files).toHaveLength(11);
  });

  it("all languages define exactly the same keys (order-independent)", () => {
    // Compared as sorted sets: a translator reordering a file is not a defect,
    // a missing or extra key is.
    for (const [lang, data] of Object.entries(i18nData)) {
      expect([...Object.keys(data)].sort(), `${lang} keyset mismatch`).toEqual(enKeys);
    }
  });

  it("no language ships an empty translation", () => {
    for (const [lang, data] of Object.entries(i18nData)) {
      for (const [key, value] of Object.entries(data)) {
        expect(typeof value, `${lang}.${key}`).toBe("string");
        expect(value.trim().length, `${lang}.${key} is empty`).toBeGreaterThan(0);
      }
    }
  });

  it("state name keys are present", () => {
    expect(enKeys).toContain("carrier");
    expect(enKeys).toContain("status");
    expect(enKeys).toContain("activeCount");
    expect(enKeys).toContain("estimateToday");
    expect(enKeys).toContain("info");
    expect(enKeys).toContain("infoConnection");
  });

  it("status_0…status_8 and packageName keys are present (v0.10.0, L20/L18)", () => {
    for (let code = 0; code <= 8; code++) {
      expect(enKeys).toContain(`status_${code}`);
    }
    expect(enKeys).toContain("packageName");
  });

  it("every %s-bearing key carries the placeholder in ALL languages", () => {
    // A translation that lost its placeholder silently drops the interpolated
    // value (tracking number / day count) for that language only.
    const placeholderKeys = Object.keys(i18nData.en).filter(k => i18nData.en[k].includes("%s"));
    expect(placeholderKeys.length, "premise: at least one key uses %s").toBeGreaterThan(0);
    for (const key of placeholderKeys) {
      for (const [lang, data] of Object.entries(i18nData)) {
        expect(data[key], `${lang}.${key} lost its %s placeholder`).toContain("%s");
      }
    }
  });
});
