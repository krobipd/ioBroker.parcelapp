"use strict";
// Generates the adapter's complete object inventory from fixtures and proves that
// an update reaches every object of an existing installation.
//
// Suite 1 "object inventory": start the adapter in the throwaway js-controller,
//   drive it with fixtures covering every status code, the unknown status, and the date forms
//   listed under "Fixture provenance" (feedFixtures), then dump every parcelapp.0.* object to
//   test/objects.inventory.json in the ioBroker object-structure bot's format.
// Suite 2 "upgrade from the previous release" (only when INVENTORY_PREVIOUS is
//   set — pre-release.py exports the last tag's inventory): seed the previous
//   objects BEFORE start, start, feed, then assert that every object carries the
//   current name/desc/role/type/unit and that removed objects are gone.
//
// parcel.app is reached over a FIXED foreign address, so there is no device to feed. The fixtures
// arrive through the adapter process's environment instead: `inventory-https-hook.cjs` reroutes
// every api.parcel.app request to the local fixture server below and refuses any other host, so
// nothing leaves the machine and the adapter keeps its production base URL.
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const assert = require("node:assert");
const { tests } = require("@iobroker/testing");

const ADAPTER_DIR = path.join(__dirname, "..");
const ADAPTER = require(path.join(ADAPTER_DIR, "io-package.json")).common.name;
const NS = `${ADAPTER}.0.`;
const INVENTORY = path.join(__dirname, "objects.inventory.json");
const VOLATILE = ["ts", "from", "user", "acl"];
const COMPARED = ["name", "desc", "role", "type", "unit"];

// Fixture provenance (audit 2026-09-25, T6). `deliveries.json` is written by hand, but every BASIC
// shape in it is one seen in a public recording of a real `GET /deliveries/` answer:
//   - `date_expected` as `YYYY-MM-DD HH:MM:SS`, a day range at midnight (`… 00:00:00` → `… 00:00:00`,
//     Amazon DE) and an hour window on one day (Amazon US): the DEVELOPER.md of datadrowner/parcelappnet
//     (https://github.com/datadrowner/parcelappnet/blob/main/DEVELOPER.md) and the Home Assistant
//     integration jmdevita/parcel-ha, issues #51 and #55 (https://github.com/jmdevita/parcel-ha/issues/55);
//   - event dates in the weekday form without a year (English day-month and month-day, German with
//     a dot after the day), the UPS dotted month-first form `MM.dd.yyyy HH:mm`: the same sources and
//     the parcel.app developer's reply in raycast/extensions PR #22239
//     (https://github.com/raycast/extensions/pull/22239);
//   - `events[].additional`: documented at https://parcelapp.net/help/api-view-deliveries.html
//     ("Additional information from the carrier"), read by the adapter nowhere.
// SYNTHETIC drift cases, marked by their tracking number: INV-DRIFT-NUMSTR (status as a numeric
// string), INV-DRIFT-UNKNOWN (unreadable status), INV-DRIFT-FORMAT (a dotted expected date nobody
// reads), INV-UNKNOWN-CARRIER, INV-NO-DESCRIPTION, and the collision triple INV-SAME-NUMBER.
const FIXTURE_DIR = path.join(__dirname, "fixtures", "inventory");
const DELIVERIES = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "deliveries.json"), "utf8"));
// supported_carriers.json is a RECORDED excerpt of https://api.parcel.app/external/supported_carriers.json
// (public file, no api-key, fetched 2026-09-15: 304 entries, every value an object
// `{ name, extra_required?, name_variations? }`). Never hand-write this shape — the v0.9.0
// hand-made `{ code: "Name" }` fixture kept the whole suite green while the real file had
// changed and the adapter showed carrier CODES on every installation (audit 2026-09-15, B1).
// `amzlus` was added on 2026-09-25 from the same recording.
const CARRIERS = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "supported_carriers.json"), "utf8"));
const HOOK = path.join(__dirname, "inventory-https-hook.cjs");

/** Adapter-specific config the fixtures need. `apiKey` is encrypted by the harness. */
const FIXTURE_NATIVE = {
  // Long enough to pass the adapter's MIN_API_KEY_LENGTH guard.
  apiKey: "fixture-api-key-0123456789",
  pollInterval: 5,
  // false -> the adapter asks for `recent` and KEEPS delivered packages, so status 0 is part of
  // the inventory too. With the default (true) the delivered fixture would be filtered away.
  autoRemoveDelivered: false,
};

/** Every object id one delivery produces: the device plus its states. */
const PACKAGE_STATES = [
  "carrier",
  "status",
  "statusCode",
  "description",
  "trackingNumber",
  "extraInfo",
  "deliveryWindow",
  "deliveryEstimate",
  "lastEvent",
  "lastLocation",
  "lastUpdated",
];

/**
 * The adapter's own id rule, loaded from the BUILT module (`src/lib/package-id.ts`) — no mirror that
 * could drift. The module has no adapter-core import on purpose: loading `state-manager.js` here
 * would pull adapter-core in, and that ends a process without a js-controller behind it.
 */
const { idCandidates, identityOf, rawIdKey } = require("../build/lib/package-id.js");

/**
 * The package ids of all fixture deliveries, handed out like the adapter's first poll does on an
 * empty tree: each delivery takes its first candidate that no earlier one owns.
 *
 * @returns {string[]} the package ids, index-aligned to DELIVERIES
 */
function packageIds() {
  const owner = new Map();
  return DELIVERIES.map(delivery => {
    const key = rawIdKey(identityOf(delivery));
    for (const candidate of idCandidates(delivery)) {
      const current = owner.get(candidate);
      if (current === undefined || current === key) {
        owner.set(candidate, key);
        return candidate;
      }
    }
    throw new Error("unreachable");
  });
}

/** Every object id the fixtures must produce — the wait criterion, and a completeness assertion. */
function expectedObjectIds() {
  const ids = [`${NS}info`, `${NS}info.connection`, `${NS}deliveries`, `${NS}summary`];
  for (const state of ["activeCount", "todayCount", "deliveryWindow"]) {
    ids.push(`${NS}summary.${state}`);
  }
  for (const pkgId of packageIds()) {
    ids.push(`${NS}deliveries.${pkgId}`);
    for (const state of PACKAGE_STATES) {
      ids.push(`${NS}deliveries.${pkgId}.${state}`);
    }
  }
  return ids;
}

/**
 * Wait until a poll has actually COMPLETED — every package carries a `carrier` VALUE and the summary is written.
 *
 * `feedFixtures` waits for the object SET, which is the right criterion for suite 1 (only the
 * adapter creates those objects) and a hollow one for suite 2: the upgrade suite SEEDS exactly
 * that set before the start, so the wait was satisfied on its first look and the assertions ran
 * 13 ms after `onReady` — before the first poll had even begun (measured 2026-09-07, parcelapp's
 * first upgrade run: the adapter's only poll attempt hit the fixture server AFTER `after()` had
 * closed it, `ECONNREFUSED`). The suite reported "desc still undefined" for the three datapoints
 * whose description was new, which reads exactly like an adapter that fails to reach existing
 * objects — while the real answer was that nothing had run yet.
 *
 * The seed writes OBJECTS only (`setObjectAsync`), so state VALUES are the one signal the seed
 * cannot fake. `info.connection` is NOT enough: main.ts sets it right after the GET succeeds and
 * before the package states are written.
 *
 * @param {import("@iobroker/testing").TestHarness} harness The integration harness
 */
async function waitForCompletedPoll(harness) {
  const wanted = expectedObjectIds().filter(id => id.endsWith(".carrier"));
  // The summary is written LAST in a poll, after every package — waiting for the carriers alone let
  // the suite judge the three summary objects before the poll had reached them (CI, 2026-09-25:
  // "desc still …" on summary.* only). `deliveryWindow` may legitimately be "", so the summary
  // counts as written once each state carries any value.
  const summary = ["activeCount", "todayCount", "deliveryWindow"].map(state => `${NS}summary.${state}`);
  const deadline = Date.now() + 60000;
  for (;;) {
    const missing = [];
    for (const id of wanted) {
      const state = await harness.states.getState(id);
      if (!state || state.val === undefined || state.val === null || state.val === "") {
        missing.push(id);
      }
    }
    for (const id of summary) {
      const state = await harness.states.getState(id);
      if (!state || state.val === undefined || state.val === null) {
        missing.push(id);
      }
    }
    if (missing.length === 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `no completed poll — ${missing.length} state(s) without a value, e.g. ${missing.slice(0, 5).join(", ")}`,
      );
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

let server;
let fixtureUrl;

/** Starts the local parcel.app stand-in and remembers its address. */
async function startFixtureServer() {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/external/supported_carriers.json") {
      return send(200, CARRIERS);
    }
    if (url.pathname === "/external/deliveries/") {
      return send(200, { success: true, deliveries: DELIVERIES });
    }
    return send(404, { success: false, error_message: `no fixture for ${url.pathname}` });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  fixtureUrl = `http://127.0.0.1:${server.address().port}`;
}

/** Stops the fixture server. */
async function stopFixtureServer() {
  if (server) {
    await new Promise(resolve => server.close(resolve));
    server = undefined;
  }
}

/**
 * Start the adapter against the fixture server and wait until every expected object exists.
 *
 * The wait criterion is the object SET, not "no new objects for N seconds": the adapter writes a
 * package's states in parallel batches, so a quiet moment mid-poll would produce a green but
 * incomplete inventory — exactly the datapoints the gate exists for.
 *
 * @param {import("@iobroker/testing").TestHarness} harness The integration harness
 */
async function feedFixtures(harness) {
  const expected = expectedObjectIds();
  const deadline = Date.now() + 60000;
  for (;;) {
    const list = await harness.objects.getObjectList({ startkey: NS, endkey: `${NS}香` });
    const have = new Set(list.rows.map(r => r.id));
    const missing = expected.filter(id => !have.has(id));
    if (missing.length === 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `fixtures did not reach the adapter — ${missing.length} objects missing, e.g. ${missing.slice(0, 5).join(", ")}`,
      );
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

async function dumpObjects(harness) {
  // The range starts at "<adapter>.0." — the instance root object itself is not part of the tree.
  const list = await harness.objects.getObjectList({ startkey: NS, endkey: `${NS}香` });
  const out = {};
  for (const row of list.rows.sort((a, b) => a.id.localeCompare(b.id))) {
    const obj = { ...row.value };
    for (const key of VOLATILE) delete obj[key];
    out[row.id] = obj;
  }
  return out;
}

tests.integration(ADAPTER_DIR, {
  defineAdditionalTests({ suite }) {
    suite("object inventory", getHarness => {
      let harness;
      before(async function () {
        this.timeout(120000);
        harness = getHarness();
        await startFixtureServer();
        await harness.changeAdapterConfig(ADAPTER, { native: FIXTURE_NATIVE });
        await harness.startAdapterAndWait(false, {
          NODE_OPTIONS: `--require ${HOOK}`,
          PARCELAPP_FIXTURE_URL: fixtureUrl,
        });
        await feedFixtures(harness);
      });

      after(async () => {
        await stopFixtureServer();
      });

      it("writes test/objects.inventory.json", async function () {
        this.timeout(30000);
        const objects = await dumpObjects(harness);
        assert.ok(Object.keys(objects).length > 0, "no objects created — fixtures did not reach the adapter");
        fs.writeFileSync(INVENTORY, `${JSON.stringify(objects, null, 2)}\n`);
      });

      it("covers every fixture delivery with its complete object set", async function () {
        this.timeout(30000);
        const objects = await dumpObjects(harness);
        for (const id of expectedObjectIds()) {
          assert.ok(objects[id], `fixture coverage gap: ${id} was never created`);
        }
      });

      // The inventory holds OBJECTS; a wrong VALUE — every carrier showing its code, as in
      // 0.9.0-0.12.1 — leaves it unchanged (audit 2026-09-25, T6). These values are checked here.
      it("writes the carrier's NAME from the list, its code only where the list knows none", async function () {
        this.timeout(30000);
        const ids = packageIds();
        for (const [index, delivery] of DELIVERIES.entries()) {
          const state = await harness.states.getState(`${NS}deliveries.${ids[index]}.carrier`);
          const known = CARRIERS[delivery.carrier_code];
          const expected = known ? known.name : String(delivery.carrier_code).toUpperCase();
          assert.strictEqual(state && state.val, expected, `carrier of ${delivery.tracking_number}`);
        }
      });

      it("gives every package device an inline pictogram", async function () {
        this.timeout(30000);
        const objects = await dumpObjects(harness);
        for (const pkgId of packageIds()) {
          const icon = objects[`${NS}deliveries.${pkgId}`].common.icon;
          assert.ok(
            typeof icon === "string" && icon.startsWith("data:image/svg+xml;base64,"),
            `device ${pkgId} has no inline icon`,
          );
        }
      });

      it("lists the plain-text meaning of every status code on statusCode", async function () {
        this.timeout(30000);
        const objects = await dumpObjects(harness);
        for (const pkgId of packageIds()) {
          const states = objects[`${NS}deliveries.${pkgId}.statusCode`].common.states;
          assert.deepStrictEqual(
            Object.keys(states).sort(),
            ["-1", "0", "1", "2", "3", "4", "5", "6", "7", "8"],
            `statusCode of ${pkgId}`,
          );
          assert.ok(
            Object.values(states).every(v => typeof v === "string" && v.length > 0),
            `statusCode of ${pkgId} carries a non-string label`,
          );
        }
      });

      // PACKAGE_STATES is a hand-kept copy of what the StateManager creates. Without this
      // assertion a new datapoint would simply be missing from the inventory — and from every
      // gate that judges it — while the suite stayed green (audit 2026-09-15, T4). Comparing in
      // BOTH directions also catches a datapoint that was removed from the code but not here.
      it("PACKAGE_STATES lists exactly the datapoints a package really creates", async function () {
        this.timeout(30000);
        const objects = await dumpObjects(harness);
        const pkgId = packageIds()[0];
        const prefix = `${NS}deliveries.${pkgId}.`;
        const actual = Object.keys(objects)
          .filter(id => id.startsWith(prefix))
          .map(id => id.slice(prefix.length))
          .filter(rest => !rest.includes("."))
          .sort();
        assert.deepStrictEqual(
          actual,
          [...PACKAGE_STATES].sort(),
          "PACKAGE_STATES and the datapoints of a real package have drifted apart",
        );
      });
    });

    const previousFile = process.env.INVENTORY_PREVIOUS;
    if (previousFile && fs.existsSync(previousFile)) {
      suite("upgrade from the previous release", getHarness => {
        let harness;
        const previous = JSON.parse(fs.readFileSync(previousFile, "utf8"));
        before(async function () {
          this.timeout(120000);
          harness = getHarness();
          // The harness registers its own before() (fresh DB) ahead of this one,
          // so the seed survives and the adapter starts on top of the OLD objects.
          for (const [id, obj] of Object.entries(previous)) {
            await harness.objects.setObjectAsync(id, obj);
          }
          await startFixtureServer();
          await harness.changeAdapterConfig(ADAPTER, { native: FIXTURE_NATIVE });
          await harness.startAdapterAndWait(false, {
            NODE_OPTIONS: `--require ${HOOK}`,
            PARCELAPP_FIXTURE_URL: fixtureUrl,
          });
          await feedFixtures(harness);
          // The seeded set makes feedFixtures a no-op here — this is the real wait.
          await waitForCompletedPoll(harness);
        });

        after(async () => {
          await stopFixtureServer();
        });

        it("every current object carries the current texts and roles", async function () {
          this.timeout(30000);
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const live = await dumpObjects(harness);
          const stale = [];
          for (const [id, obj] of Object.entries(current)) {
            const got = live[id];
            if (!got) {
              stale.push(`${id}: missing after upgrade`);
              continue;
            }
            for (const f of COMPARED) {
              if (JSON.stringify(got.common?.[f]) !== JSON.stringify(obj.common?.[f])) {
                stale.push(`${id}: ${f} still ${JSON.stringify(got.common?.[f])}`);
              }
            }
          }
          assert.deepStrictEqual(stale, [], "objects an update did not reach:\n" + stale.join("\n"));
        });

        it("objects the release removed are gone (no leftovers)", async function () {
          this.timeout(30000);
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const live = await dumpObjects(harness);
          const leftovers = Object.keys(previous).filter(id => !(id in current) && id in live);
          assert.deepStrictEqual(leftovers, [], "leftover objects:\n" + leftovers.join("\n"));
        });
      });
    }
  },
});
