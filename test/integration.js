const path = require("node:path");
const { tests } = require("@iobroker/testing");

// Start test: boots the adapter in a real js-controller WITHOUT an API key — it catches module-scope
// crashes and a broken start path, nothing more. The operating path (poll, client, state manager
// against fixture answers) is covered by the object-inventory run (test/inventory.js), which the
// CI job `adapter-inventory` runs on every push (audit 2026-09-25, T11).
// See https://github.com/ioBroker/testing for a detailed explanation and further options.
tests.integration(path.join(__dirname, ".."));
