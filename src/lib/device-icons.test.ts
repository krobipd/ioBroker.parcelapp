import type * as fs from "node:fs";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { carrierIcon, FALLBACK_ICON, ICON_BY_CARRIER, ICON_URI_PREFIX, normaliseLineEndings } from "./device-icons";

const ICON_DIR = join(__dirname, "..", "..", "admin", "icons");

/** Shape of the freshly imported module in the CRLF test below. */
type FreshModule = { carrierIcon: typeof carrierIcon };

/**
 * Decode an inline icon URI back to its markup.
 *
 * @param uri The `data:image/svg+xml;base64,…` value written to `common.icon`.
 */
function decode(uri: string): string {
  expect(uri.startsWith(ICON_URI_PREFIX)).toBe(true);
  return Buffer.from(uri.slice(ICON_URI_PREFIX.length), "base64").toString("utf8");
}

describe("carrierIcon", () => {
  it("returns the file's own bytes, LF-normalised, as an inline URI — never a path", () => {
    const uri = carrierIcon("dhl")!;
    expect(uri.startsWith(ICON_URI_PREFIX)).toBe(true);
    expect(uri).not.toContain("/icons/");
    const expected = normaliseLineEndings(readFileSync(join(ICON_DIR, "dhl.svg"), "utf8"));
    expect(decode(uri)).toBe(expected);
  });

  it("resolves every mapped carrier code to its own file", () => {
    for (const [code, file] of Object.entries(ICON_BY_CARRIER)) {
      const expected = normaliseLineEndings(readFileSync(join(ICON_DIR, file), "utf8"));
      expect(decode(carrierIcon(code)!), code).toBe(expected);
    }
  });

  it("gives an unlisted, empty or non-string carrier code the generic van", () => {
    const van = normaliseLineEndings(readFileSync(join(ICON_DIR, FALLBACK_ICON), "utf8"));
    const codes: unknown[] = ["this-carrier-does-not-exist", "", 42, null, undefined, {}];
    for (const [index, code] of codes.entries()) {
      expect(decode(carrierIcon(code)!), `case ${index}`).toBe(van);
    }
  });

  it("does not resolve an INHERITED property to a function", () => {
    // `ICON_BY_CARRIER["constructor"]` without an own-property check would hand
    // back Object's constructor and blow up at `readFileSync`.
    const van = normaliseLineEndings(readFileSync(join(ICON_DIR, FALLBACK_ICON), "utf8"));
    for (const code of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      expect(decode(carrierIcon(code)!), code).toBe(van);
    }
  });

  it("returns the identical value when asked repeatedly (cached, stable)", () => {
    expect(carrierIcon("ups")).toBe(carrierIcon("ups"));
  });

  it("an unreadable file gives no icon and is NOT cached — the next call reads again (audit T4a)", async () => {
    const actual = await vi.importActual<typeof fs>("node:fs");
    let failNext = true;
    vi.doMock("node:fs", () => ({
      ...actual,
      readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
        if (failNext) {
          failNext = false;
          throw new Error("EACCES");
        }
        return actual.readFileSync(...args);
      },
    }));
    try {
      vi.resetModules();
      const fresh: FreshModule = await import("./device-icons.js");
      expect(fresh.carrierIcon("gls")).toBeUndefined();
      expect(fresh.carrierIcon("gls")).toBe(carrierIcon("gls"));
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("a CRLF checkout produces the SAME URI as an LF checkout", async () => {
    // The Windows runner checks out with CRLF. Embedding the raw bytes would
    // yield a different URI there, so every comparison against a recorded
    // inventory would be red on Windows only. Proven without Windows: a FRESH
    // module (the URI cache is module-level) reads the file through a CRLF
    // lens and must produce the LF value. Nothing is written into admin/icons
    // (audit T10 — an interrupted run used to leave a CRLF file in the tree).
    const lf = readFileSync(join(ICON_DIR, "dpd.svg"), "utf8").replace(/\r\n/g, "\n");
    expect(normaliseLineEndings(lf.replace(/\n/g, "\r\n"))).toBe(lf);

    const before = carrierIcon("dpdpcode");
    const actual = await vi.importActual<typeof fs>("node:fs");
    vi.doMock("node:fs", () => ({
      ...actual,
      readFileSync: (...args: Parameters<typeof actual.readFileSync>) =>
        String(actual.readFileSync(...args)).replace(/\r?\n/g, "\r\n"),
    }));
    try {
      vi.resetModules();
      const fresh: FreshModule = await import("./device-icons.js");
      expect(fresh.carrierIcon("dpdpcode")).toBe(before);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  describe("the map against parcel.app's carrier list (audit B10)", () => {
    /** The public list as served on 2026-09-25 (302 entries), recorded unchanged. */
    const recorded: Record<string, { name: string }> = JSON.parse(
      readFileSync(join(__dirname, "..", "..", "test", "fixtures", "supported_carriers-2026-09-25.json"), "utf8"),
    );
    /** Codes parcel.app dropped that stay mapped, so packages added under them keep their mark. */
    const removedButKept = new Set(["nzp"]);

    it("maps only codes parcel.app lists — or ones it dropped, on purpose", () => {
      expect(Object.keys(recorded)).toHaveLength(302);
      const unknown = Object.keys(ICON_BY_CARRIER).filter(code => !(code in recorded) && !removedButKept.has(code));
      expect(unknown).toEqual([]);
      for (const code of removedButKept) {
        expect(code in recorded, code).toBe(false);
      }
    });

    it("gives national postal operators and their express arms the envelope — private couriers the van", () => {
      for (const code of ["tntp", "tntpit", "tntpitp", "postnord", "bring", "tourline", "anpost"]) {
        expect(ICON_BY_CARRIER[code], code).toBe("post.svg");
      }
      // Nova Poshta and Geniki Taxydromiki are private couriers, not postal operators.
      for (const code of ["newp", "geniki"]) {
        expect(Object.hasOwn(ICON_BY_CARRIER, code), code).toBe(false);
      }
      expect(Object.values(ICON_BY_CARRIER).filter(file => file === "post.svg")).toHaveLength(72);
    });

    it("gives FedEx and InPost their own monogram (audit B10b)", () => {
      for (const code of ["fedex", "fedpl"]) {
        expect(ICON_BY_CARRIER[code], code).toBe("fedex.svg");
      }
      for (const code of ["inpost", "inpostit", "inpostuk", "inpespcode"]) {
        expect(ICON_BY_CARRIER[code], code).toBe("inpost.svg");
      }
    });
  });
});

describe("admin/icons", () => {
  const files = readdirSync(ICON_DIR).filter(f => f.endsWith(".svg"));

  it("has a file for every map entry and the fallback, and no orphan", () => {
    const used = new Set([...Object.values(ICON_BY_CARRIER), FALLBACK_ICON]);
    for (const file of used) {
      expect(files, file).toContain(file);
    }
    for (const file of files) {
      expect(used, file).toContain(file);
    }
  });

  it("uses only currentColor and none as colours", () => {
    for (const file of files) {
      const svg = readFileSync(join(ICON_DIR, file), "utf8");
      const colours = [...svg.matchAll(/(?:fill|stroke)="([^"]*)"/g)].map(m => m[1]);
      expect(colours.length, file).toBeGreaterThan(0);
      for (const colour of colours) {
        expect(["currentColor", "none"], `${file}: ${colour}`).toContain(colour);
      }
    }
  });

  it("draws with path and circle only — the id-cell CSS zeroes the geometry elements", () => {
    for (const file of files) {
      const svg = readFileSync(join(ICON_DIR, file), "utf8");
      const body = svg.slice(svg.indexOf(">") + 1);
      expect(body, file).not.toMatch(/<(rect|image|use|svg|foreignObject)[\s/>]/);
    }
  });

  it("is drawn on the 64-unit grid the recipe prescribes", () => {
    for (const file of files) {
      const svg = readFileSync(join(ICON_DIR, file), "utf8");
      expect(svg, file).toContain('viewBox="0 0 64 64"');
    }
  });

  // Deliberately NO "the repo holds LF-only bytes" test: on the Windows runner git
  // checks the files out with CRLF, so such a test measures the checkout and not
  // the repo — and turns the Windows job red. `normaliseLineEndings` before
  // embedding is the guarantee, and the test above measures exactly that.
});
