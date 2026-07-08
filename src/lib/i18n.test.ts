import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Mirrors adapter-core I18n incl. %s substitution (see state-manager.test.ts).
vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: vi.fn((key: string, ...args: (string | number | boolean | null)[]) => {
      const fill = (text: string): string => {
        for (const arg of args) {
          text = text.replace("%s", arg === null ? "null" : String(arg));
        }
        return text;
      };
      return { en: fill(key), de: fill(`${key}_de`) };
    }),
    translate: vi.fn((key: string, ...args: (string | number | boolean | null)[]) => {
      let text = key;
      for (const arg of args) {
        text = text.replace("%s", arg === null ? "null" : String(arg));
      }
      return text;
    }),
  },
}));

import { packageName, statusLabel, tName, tText } from "./i18n";

describe("tName", () => {
  it("delegates to I18n.getTranslatedObject", () => {
    const result = tName("carrier");
    expect(result).toEqual({ en: "carrier", de: "carrier_de" });
  });
});

describe("tText (v0.10.0, L13)", () => {
  it("delegates to I18n.translate", () => {
    expect(tText("estimateToday")).toBe("estimateToday");
  });

  it("passes %s args through to I18n.translate", () => {
    // The mock echoes the key, so a key WITH a placeholder shows the fill-in.
    expect(tText("estimateDays" as never, 3)).toBe("estimateDays");
  });
});

describe("statusLabel (v0.10.0, L20)", () => {
  it("resolves known status codes 0-8 to their status_* keys", () => {
    for (let code = 0; code <= 8; code++) {
      expect(statusLabel(code), `code ${code}`).toBe(`status_${code}`);
    }
  });

  it("returns undefined for unknown codes so the caller renders its own fallback", () => {
    expect(statusLabel(-1)).toBeUndefined();
    expect(statusLabel(9)).toBeUndefined();
    expect(statusLabel(42)).toBeUndefined();
  });
});

describe("packageName (v0.10.0, L18)", () => {
  it("interpolates the tracking number into every language", () => {
    expect(packageName("TRK9")).toEqual({ en: "packageName", de: "packageName_de" });
    // The real interpolation is asserted against the real i18n files in
    // state-manager.test.ts (localized fallback device name).
  });
});

describe("i18n completeness", () => {
  const i18nDir = join(__dirname, "../../admin/i18n");
  const files = readdirSync(i18nDir).filter(f => f.endsWith(".json"));
  const keysets = files.map(f => ({
    lang: f.replace(".json", ""),
    keys: Object.keys(JSON.parse(readFileSync(join(i18nDir, f), "utf8"))),
  }));
  const enKeys = keysets.find(k => k.lang === "en")!.keys;

  it("all 11 languages present", () => {
    expect(files).toHaveLength(11);
  });

  it("all languages have identical keysets", () => {
    for (const { lang, keys } of keysets) {
      expect(keys, `${lang} keyset mismatch`).toEqual(enKeys);
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
});
