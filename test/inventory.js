"use strict";
// Generates the adapter's complete object inventory from fixtures and proves that
// an update reaches every object of an existing installation.
//
// Suite 1 "object inventory": start the adapter in the throwaway js-controller,
//   drive it with fixtures covering EVERY status code and window shape the adapter
//   supports (feedFixtures), then dump every parcelapp.0.* object to
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

const FIXTURE_DIR = path.join(__dirname, "fixtures", "inventory");
const DELIVERIES = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "deliveries.json"), "utf8"));
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
 * The adapter's own id rule (`StateManager.sanitize` + `packageId`), mirrored so the test knows
 * exactly which objects to wait for instead of waiting for "the tree stopped growing".
 *
 * @param {string} value Raw value to sanitize
 * @returns {string} the sanitized id segment
 */
function sanitize(value) {
  return (
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 50) || "unknown"
  );
}

/**
 * Package id of a fixture delivery.
 *
 * @param {Record<string, unknown>} delivery Fixture delivery
 * @returns {string} the package id
 */
function packageId(delivery) {
  let id = sanitize(delivery.tracking_number);
  if (typeof delivery.extra_information === "string" && delivery.extra_information.length > 0) {
    id += `_${sanitize(delivery.extra_information)}`;
  }
  return id;
}

/** Every object id the fixtures must produce — the wait criterion, and a completeness assertion. */
function expectedObjectIds() {
  const ids = [`${NS}info`, `${NS}info.connection`, `${NS}deliveries`, `${NS}summary`];
  for (const state of ["activeCount", "todayCount", "deliveryWindow"]) {
    ids.push(`${NS}summary.${state}`);
  }
  for (const delivery of DELIVERIES) {
    const pkgId = packageId(delivery);
    ids.push(`${NS}deliveries.${pkgId}`);
    for (const state of PACKAGE_STATES) {
      ids.push(`${NS}deliveries.${pkgId}.${state}`);
    }
  }
  return ids;
}

/**
 * Wait until a poll has actually COMPLETED — every package carries a `carrier` VALUE.
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
  const deadline = Date.now() + 60000;
  for (;;) {
    const missing = [];
    for (const id of wanted) {
      const state = await harness.states.getState(id);
      if (!state || state.val === undefined || state.val === null || state.val === "") {
        missing.push(id);
      }
    }
    if (missing.length === 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `no completed poll — ${missing.length} package(s) without a carrier value, e.g. ${missing.slice(0, 5).join(", ")}`,
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

      it("covers every status code and window shape the adapter supports", async function () {
        this.timeout(30000);
        const objects = await dumpObjects(harness);
        for (const id of expectedObjectIds()) {
          assert.ok(objects[id], `fixture coverage gap: ${id} was never created`);
        }
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
