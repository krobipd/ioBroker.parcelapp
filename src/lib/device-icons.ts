import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Carrier pictograms for the package device objects (`common.icon`).
 *
 * Four things about this are MEASURED against the live admin, not assumed
 * (fleet recipe, `Entwicklung/CLAUDE_PATTERNS.md` § Geräte-Piktogramme):
 *
 * 1. The value is the FILE ITSELF as an inline `data:image/svg+xml;base64,…`
 *    URI, never a path. The admin inlines that form into the DOM; a path lands
 *    in a bare `<img>` without filter or mask, and the admin does NOT invert
 *    object icons — a path icon keeps its fixed colour and is invisible in one
 *    theme family.
 * 2. Only `currentColor` or `none` as fill/stroke, so the same file reads on
 *    light and on dark themes.
 * 3. Only `path` and `circle`. The id-cell CSS reaches INTO the inlined markup
 *    (`cellId: { "& *": { width: "initial" } }`), and for `rect`, `image`,
 *    `use`, nested `svg` and `foreignObject` `initial` means 0 — such an
 *    element comes out 0 px wide.
 * 4. Drawn for 28 px (`ROW_HEIGHT - 4`): one or two features, no hairlines.
 *
 * The map is keyed on `carrier_code`, not on the carrier NAME: the code is what
 * the API guarantees, while the name arrives from a file whose format changed
 * under us (audit 2026-09-15, B1). Every code that is not listed — and every
 * carrier parcel.app adds in the future — gets the generic delivery van.
 */
export const ICON_BY_CARRIER: Readonly<Record<string, string>> = {
  // DHL — 8 codes
  dhl: "dhl.svg",
  dhlfreight: "dhl.svg",
  dhlgf: "dhl.svg",
  dhlgm: "dhl.svg",
  dhlnl: "dhl.svg",
  dhlpoland: "dhl.svg",
  dhlsc: "dhl.svg",
  dhluk: "dhl.svg",
  // Deutsche Post — 2 codes
  dp: "deutschepost.svg",
  dpr: "deutschepost.svg",
  // Hermes / Evri — 3 codes
  her2mann: "hermes.svg",
  hermes: "hermes.svg",
  myher: "hermes.svg",
  // DPD — 8 codes
  dpdat: "dpd.svg",
  dpdfrpcode: "dpd.svg",
  dpdgpcode: "dpd.svg",
  dpdie: "dpd.svg",
  dpditpcode: "dpd.svg",
  dpdpcode: "dpd.svg",
  dpdpoland: "dpd.svg",
  dpduk: "dpd.svg",
  // GLS (incl. its national brands) — 5 codes
  asmred: "gls.svg",
  dicom: "gls.svg",
  gls: "gls.svg",
  glsit: "gls.svg",
  gso: "gls.svg",
  // UPS — 2 codes
  ups: "ups.svg",
  upsmi: "ups.svg",
  // Amazon Logistics — 26 codes
  amshipfr: "amazon.svg",
  amshipit: "amazon.svg",
  amshipuk: "amazon.svg",
  amzlae: "amazon.svg",
  amzlau: "amazon.svg",
  amzlbe: "amazon.svg",
  amzlbr: "amazon.svg",
  amzlca: "amazon.svg",
  amzlde: "amazon.svg",
  amzleg: "amazon.svg",
  amzles: "amazon.svg",
  amzlfr: "amazon.svg",
  amzlie: "amazon.svg",
  amzlin: "amazon.svg",
  amzlit: "amazon.svg",
  amzljp: "amazon.svg",
  amzlmx: "amazon.svg",
  amzlnl: "amazon.svg",
  amzlpl: "amazon.svg",
  amzlsa: "amazon.svg",
  amzlse: "amazon.svg",
  amzlsg: "amazon.svg",
  amzltr: "amazon.svg",
  amzluk: "amazon.svg",
  amzlus: "amazon.svg",
  swiship: "amazon.svg",
  // USPS — 1 codes
  usps: "usps.svg",
  // TNT — 4 codes
  tnt: "tnt.svg",
  tntau: "tnt.svg",
  tntfr: "tnt.svg",
  tntit: "tnt.svg",
  // Apple Store — 2 codes
  apple: "apple.svg",
  appleexp: "apple.svg",
  // Vinted Go — 1 codes
  vinted: "vinted.svg",
  // DoorDash — 1 codes
  doordash: "doordash.svg",
  // national postal operators — 68 codes
  anpost: "post.svg",
  at: "post.svg",
  au: "post.svg",
  azer: "post.svg",
  blp: "post.svg",
  bolg: "post.svg",
  bpost: "post.svg",
  cems: "post.svg",
  ceska: "post.svg",
  china: "post.svg",
  chrexp: "post.svg",
  chrono: "post.svg",
  chronop: "post.svg",
  colomb: "post.svg",
  cor: "post.svg",
  corbra: "post.svg",
  corm: "post.svg",
  corurg: "post.svg",
  coup: "post.svg",
  cp: "post.svg",
  ctt: "post.svg",
  cypr: "post.svg",
  dk: "post.svg",
  ee: "post.svg",
  elta: "post.svg",
  emirates: "post.svg",
  ems: "post.svg",
  geniki: "post.svg",
  hk: "post.svg",
  hr: "post.svg",
  hung: "post.svg",
  il: "post.svg",
  in: "post.svg",
  indon: "post.svg",
  it: "post.svg",
  jordan: "post.svg",
  jp: "post.svg",
  kor: "post.svg",
  kz: "post.svg",
  litva: "post.svg",
  lp: "post.svg",
  lv: "post.svg",
  malpos: "post.svg",
  malta: "post.svg",
  moldov: "post.svg",
  newp: "post.svg",
  nor: "post.svg",
  nzp: "post.svg",
  phlpost: "post.svg",
  pk: "post.svg",
  poland: "post.svg",
  posti: "post.svg",
  ptl: "post.svg",
  rm: "post.svg",
  rp: "post.svg",
  safr: "post.svg",
  saudi: "post.svg",
  se: "post.svg",
  serbia: "post.svg",
  serpost: "post.svg",
  sing: "post.svg",
  slovak: "post.svg",
  slv: "post.svg",
  swiss: "post.svg",
  thai: "post.svg",
  turk: "post.svg",
  tw: "post.svg",
  ukr: "post.svg",
};

/** The pictogram every unlisted carrier gets. */
export const FALLBACK_ICON = "truck.svg";

/** Prefix of an inline SVG data URI — the only form the admin renders theme-aware. */
export const ICON_URI_PREFIX = "data:image/svg+xml;base64,";

// `build/lib` and `src/lib` both sit two levels below the adapter root, so the
// same relative path works for the bundle and for the tests.
const ICON_DIR = join(__dirname, "..", "..", "admin", "icons");

const cache = new Map<string, string>();

/**
 * CRLF → LF. The Windows CI runner checks out with CRLF, so embedding the raw
 * bytes would produce a different URI there — and every test that compares the
 * object value against a recorded inventory would be red on Windows only.
 *
 * @param svg The file contents as read from disk.
 */
export function normaliseLineEndings(svg: string): string {
  return svg.replace(/\r\n/g, "\n");
}

/**
 * The inline icon URI for a carrier code, or `undefined` when the file cannot
 * be read (then the object's `icon` field is left untouched rather than
 * emptied).
 *
 * @param carrierCode The `carrier_code` of the delivery, untrusted.
 */
export function carrierIcon(carrierCode: unknown): string | undefined {
  // API boundary + inherited properties: `Object.hasOwn` keeps "constructor"
  // and friends from resolving to a function.
  const file =
    typeof carrierCode === "string" && Object.hasOwn(ICON_BY_CARRIER, carrierCode)
      ? ICON_BY_CARRIER[carrierCode]
      : FALLBACK_ICON;
  const cached = cache.get(file);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const svg = normaliseLineEndings(readFileSync(join(ICON_DIR, file), "utf8"));
    const uri = `${ICON_URI_PREFIX}${Buffer.from(svg).toString("base64")}`;
    cache.set(file, uri);
    return uri;
  } catch {
    // Unreadable file (a broken install, a missing `files` entry): no icon this
    // process. Deliberately not cached, so a later poll can succeed.
    return undefined;
  }
}
