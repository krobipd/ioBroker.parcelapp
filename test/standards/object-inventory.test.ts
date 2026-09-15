import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The object inventory is generated from fixtures (`npm run test:inventory`) and
 * judged by the release run. `COMPARED` of the upgrade suite does not look at
 * `common.icon`, so without this block an icon could silently become a path, a
 * stale file or nothing at all and every gate would stay green.
 */
const INVENTORY = join(__dirname, "..", "objects.inventory.json");
const ICON_DIR = join(__dirname, "..", "..", "admin", "icons");
const PREFIX = "data:image/svg+xml;base64,";

describe("object inventory: package pictograms", () => {
  const raw = JSON.parse(readFileSync(INVENTORY, "utf8")) as Record<
    string,
    { type?: string; common?: { icon?: unknown } }
  >;
  const known = new Map(
    readdirSync(ICON_DIR)
      .filter(f => f.endsWith(".svg"))
      .map(f => [readFileSync(join(ICON_DIR, f), "utf8").replace(/\r\n/g, "\n"), f] as const),
  );

  it("every package device carries an icon that IS one of the files in admin/icons", () => {
    const devices = Object.entries(raw).filter(([id, o]) => o.type === "device" && id.includes(".deliveries."));
    expect(devices.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const [id, obj] of devices) {
      const icon = obj.common?.icon;
      if (typeof icon !== "string" || !icon.startsWith(PREFIX)) {
        offenders.push(`${id}: common.icon is not an inline SVG data URI (${typeof icon})`);
        continue;
      }
      const markup = Buffer.from(icon.slice(PREFIX.length), "base64").toString("utf8");
      if (!known.has(markup)) {
        offenders.push(`${id}: the inline icon is not one of the files in admin/icons`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
