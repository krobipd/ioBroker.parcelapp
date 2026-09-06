"use strict";
// Fixture transport for `npm run test:inventory`.
//
// Loaded into the ADAPTER process via `NODE_OPTIONS=--require <this file>`, so the adapter itself
// needs no test seam: production code keeps its hardcoded `https://api.parcel.app/external` base
// URL. Every request to that host is rerouted to the fixture server the test started on localhost,
// and any OTHER host is refused loudly — a forgotten route fails the run instead of silently
// reaching the real API.
const http = require("node:http");
const https = require("node:https");

const target = process.env.PARCELAPP_FIXTURE_URL;
if (!target) {
  throw new Error("PARCELAPP_FIXTURE_URL is not set — the inventory hook cannot route parcel.app requests");
}
const fixture = new URL(target);

/**
 * Host of an outgoing request, whichever call shape node's http/https API was given.
 *
 * @param {string | URL | https.RequestOptions} options Request options, URL or URL string
 * @returns {string} the hostname, or "" when it cannot be determined
 */
function hostOf(options) {
  if (typeof options === "string") {
    return new URL(options).hostname;
  }
  if (options instanceof URL) {
    return options.hostname;
  }
  return options.hostname || options.host || "";
}

https.request = function fixtureRequest(options, callback) {
  const host = hostOf(options);
  if (host !== "api.parcel.app") {
    throw new Error(`inventory fixture: refusing HTTPS request to unexpected host '${host}'`);
  }
  const rerouted = {
    ...(typeof options === "object" && !(options instanceof URL) ? options : {}),
    protocol: "http:",
    hostname: fixture.hostname,
    host: undefined,
    port: fixture.port,
  };
  return http.request(rerouted, callback);
};
