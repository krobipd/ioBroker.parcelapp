import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import { FORBIDDEN_HINT, ParcelClient, type ParcelClientTimers } from "./parcel-client";

/**
 * Node's global agent keeps sockets alive (measured: ONE TCP connection serves
 * two sequential requests). Against a throw-away mock server that is a race:
 * a pooled socket the server has just dropped can be picked for the next
 * request, which then fails with a transport error — the test reads that as
 * "the client returned nothing" and goes red for a reason that has nothing to
 * do with the code under test. It bit us once on a slow Windows runner
 * (2026-08-21). Production is unaffected (a poll every 10 minutes never reuses
 * a socket), so the fix belongs here, not in the client.
 */
// `keepAlive` is a real runtime property of the agent (verified: the default
// agent reports true) but the bundled @types/node only declares it as a
// constructor option — narrow locally instead of trusting the stale type, the
// same way parcel-client.ts does for setStateChangedAsync's result.
const agent = http.globalAgent as http.Agent & { keepAlive: boolean };
let keepAliveBefore = false;

beforeAll(() => {
  keepAliveBefore = agent.keepAlive;
  agent.keepAlive = false;
});
afterAll(() => {
  // The agent is process-global and vitest reuses worker processes across
  // files — hand it back the way we found it instead of leaving a flipped
  // switch behind for whatever runs next.
  agent.keepAlive = keepAliveBefore;
  agent.destroy();
});
afterEach(() => {
  // Drop any socket still pooled from the test that just finished, so the next
  // test cannot inherit a connection to a server that is already closed.
  http.globalAgent.destroy();
});

/**
 * Helper: start a local HTTP server that returns predefined responses.
 * Returns the server and its base URL (http://127.0.0.1:<port>).
 *
 * @param handler Request handler that writes the canned response
 */
function startMockServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; port: number }> {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}

function stopServer(server: http.Server): Promise<void> {
  return new Promise(resolve => {
    server.close(() => resolve());
  });
}

/**
 * Plain timers for the client's deadline seam — production passes the adapter's own
 * `this.setTimeout`/`this.clearTimeout` (fleet rule), tests use the platform ones.
 */
const testTimers: ParcelClientTimers = {
  setTimeout: (cb: () => void, ms: number): unknown => setTimeout(cb, ms),
  clearTimeout: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout> | undefined),
};

/**
 * Create a ParcelClient pointed at a local HTTP mock server. Uses the REAL
 * `request()` (transport is selected from the baseUrl protocol), so the
 * production transport hardening — AbortController/cancelAll, body-size cap,
 * retry-after clamp, status→code mapping, URL validation — is what these
 * tests exercise. No reimplementation, no monkey-patch.
 *
 * @param apiKey API key the client sends
 * @param port Port of the local mock server
 */
function createTestClient(apiKey: string, port: number): ParcelClient {
  return new ParcelClient(apiKey, testTimers, undefined, `http://127.0.0.1:${port}/external`);
}

describe("ParcelClient transport details (audit 2026-09-25)", () => {
  it("an API key with an invisible character fails as INVALID_API_KEY and leaves nothing in flight (L6)", async () => {
    const { server, port } = await startMockServer((_req, res) => {
      res.end("{}");
    });
    try {
      const client = createTestClient("abcdefghijk\u200B", port);
      await expect(client.getDeliveries("active")).rejects.toMatchObject({ code: "INVALID_API_KEY" });
      expect((client as unknown as { inflight: Set<unknown> }).inflight.size).toBe(0);
    } finally {
      await stopServer(server);
    }
  });

  it("the deadline timer is cancelled as soon as the request settles (L10)", async () => {
    const cleared: unknown[] = [];
    const timers: ParcelClientTimers = {
      setTimeout: (cb: () => void, ms: number): unknown => testTimers.setTimeout(cb, ms),
      clearTimeout: (handle: unknown): void => {
        cleared.push(handle);
        testTimers.clearTimeout(handle);
      },
    };
    const { server, port } = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, deliveries: [] }));
    });
    try {
      const client = new ParcelClient("key", timers, undefined, `http://127.0.0.1:${port}/external`);
      await client.getDeliveries("active");
      expect(cleared.filter(h => h !== undefined)).toHaveLength(1);
    } finally {
      await stopServer(server);
    }
  });

  it("a POST carries Content-Length, never a chunked body (audit X3)", async () => {
    let seen: http.IncomingHttpHeaders = {};
    const { server, port } = await startMockServer((req, res) => {
      seen = req.headers;
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      });
    });
    try {
      const client = createTestClient("key", port);
      await client.addDelivery({ tracking_number: "T1", carrier_code: "dhl", description: "Päckchen" });
      const expected = Buffer.byteLength(
        JSON.stringify({ tracking_number: "T1", carrier_code: "dhl", description: "Päckchen" }),
      );
      expect(seen["content-length"]).toBe(String(expected));
      expect(seen["transfer-encoding"]).toBeUndefined();
    } finally {
      await stopServer(server);
    }
  });
});

describe("ParcelClient.parseRetryAfter (audit L8 — the one place the cooldown is clamped)", () => {
  const now = Date.UTC(2026, 8, 25, 12, 0, 0);
  it("reads delay-seconds and clamps a tiny value UP to the 60 s floor", () => {
    expect(ParcelClient.parseRetryAfter("120", now)).toBe(120);
    expect(ParcelClient.parseRetryAfter("30", now)).toBe(60);
    expect(ParcelClient.parseRetryAfter("999999999", now)).toBe(24 * 3600);
  });
  it("reads an HTTP-date (RFC 9110) as the seconds until then", () => {
    expect(ParcelClient.parseRetryAfter(new Date(now + 2 * 3600_000).toUTCString(), now)).toBe(7200);
  });
  it("falls back to 5 minutes for anything unusable", () => {
    for (const v of [undefined, "", "0", "-5", "abc", "120abc", new Date(now - 60_000).toUTCString()]) {
      expect(ParcelClient.parseRetryAfter(v, now), String(v)).toBe(300);
    }
  });
});

describe("ParcelClient", () => {
  describe("getDeliveries", () => {
    it("should return deliveries on success", async () => {
      const deliveries = [
        {
          carrier_code: "dhl",
          description: "Test Package",
          status_code: 2,
          tracking_number: "123456",
        },
      ];

      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, deliveries }));
      });

      try {
        const client = createTestClient("test-key", port);
        const result = await client.getDeliveries("active");
        expect(result).toEqual(deliveries);
      } finally {
        await stopServer(server);
      }
    });

    it("should return empty array when no deliveries", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      });

      try {
        const client = createTestClient("test-key", port);
        const result = await client.getDeliveries("active");
        expect(result).toEqual([]);
      } finally {
        await stopServer(server);
      }
    });

    it("should classify a success:false body as API_ERROR (invalid key is detected via HTTP 401, not a body field)", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: false,
            error_message: "Invalid API key",
          }),
        );
      });

      try {
        const client = createTestClient("bad-key", port);
        await client.getDeliveries("active");
        throw new Error("Should have thrown");
      } catch (err) {
        const error = err as Error & { code: string };
        expect(error.code).toBe("API_ERROR");
        expect(error.message).toContain("Invalid API key");
      } finally {
        await stopServer(server);
      }
    });

    it("should throw on API error with generic error code", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: false,
            error_message: "Something went wrong",
          }),
        );
      });

      try {
        const client = createTestClient("key", port);
        await client.getDeliveries("active");
        throw new Error("Should have thrown");
      } catch (err) {
        const error = err as Error & { code: string };
        expect(error.code).toBe("API_ERROR");
        expect(error.message).toContain("Something went wrong");
      } finally {
        await stopServer(server);
      }
    });

    it("should send api-key header", async () => {
      let receivedApiKey = "";

      const { server, port } = await startMockServer((req, res) => {
        receivedApiKey = req.headers["api-key"] as string;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, deliveries: [] }));
      });

      try {
        const client = createTestClient("my-secret-key", port);
        await client.getDeliveries("active");
        expect(receivedApiKey).toBe("my-secret-key");
      } finally {
        await stopServer(server);
      }
    });

    it("should pass filter_mode in query string", async () => {
      let receivedPath = "";

      const { server, port } = await startMockServer((req, res) => {
        receivedPath = req.url || "";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, deliveries: [] }));
      });

      try {
        const client = createTestClient("key", port);
        await client.getDeliveries("recent");
        expect(receivedPath).toContain("filter_mode=recent");
      } finally {
        await stopServer(server);
      }
    });

    it("should default to active filter", async () => {
      let receivedPath = "";

      const { server, port } = await startMockServer((req, res) => {
        receivedPath = req.url || "";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, deliveries: [] }));
      });

      try {
        const client = createTestClient("key", port);
        await client.getDeliveries();
        expect(receivedPath).toContain("filter_mode=active");
      } finally {
        await stopServer(server);
      }
    });
  });

  describe("HTTP error handling", () => {
    it("should detect rate limiting (429)", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(429, { "Content-Type": "text/plain", "Retry-After": "120" });
        res.end("Too many requests");
      });

      try {
        const client = createTestClient("key", port);
        await client.getDeliveries("active");
        throw new Error("Should have thrown");
      } catch (err) {
        const error = err as Error & { code: string; retryAfterSeconds: number };
        expect(error.code).toBe("RATE_LIMITED");
        expect(error.retryAfterSeconds).toBe(120);
        expect(error.message).toContain("Rate limit");
      } finally {
        await stopServer(server);
      }
    });

    it("should use default retry-after when header missing", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(429, { "Content-Type": "text/plain" });
        res.end("Too many requests");
      });

      try {
        const client = createTestClient("key", port);
        await client.getDeliveries("active");
        throw new Error("Should have thrown");
      } catch (err) {
        const error = err as Error & { code: string; retryAfterSeconds: number };
        expect(error.code).toBe("RATE_LIMITED");
        expect(error.retryAfterSeconds).toBe(300); // 5 * 60
      } finally {
        await stopServer(server);
      }
    });

    it("should detect invalid API key on 401", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("Unauthorized");
      });

      try {
        const client = createTestClient("key", port);
        await client.getDeliveries("active");
        throw new Error("Should have thrown");
      } catch (err) {
        const error = err as Error & { code: string };
        expect(error.code).toBe("INVALID_API_KEY");
      } finally {
        await stopServer(server);
      }
    });

    it("should set FORBIDDEN code on 403 (P3 v0.4.2)", async () => {
      // v0.4.2 (P3): 403 is a permission issue (e.g. Premium expired);
      // distinct from INVALID_API_KEY (401) so the adapter can show a
      // helpful "check your account" hint instead of looping reauth.
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
      });

      try {
        const client = createTestClient("key", port);
        await client.getDeliveries("active");
        throw new Error("Should have thrown");
      } catch (err) {
        const error = err as Error & { code: string };
        expect(error.code).toBe("FORBIDDEN");
      } finally {
        await stopServer(server);
      }
    });

    it("should return HTTP_ERROR for 500", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      });

      try {
        const client = createTestClient("key", port);
        await client.getDeliveries("active");
        throw new Error("Should have thrown");
      } catch (err) {
        const error = err as Error & { code: string };
        expect(error.code).toBe("HTTP_ERROR");
        expect(error.message).toContain("500");
      } finally {
        await stopServer(server);
      }
    });

    it("carries parcel.app's own error_message from a 400 body into the error (v0.13.0)", async () => {
      // parcel.app answers non-2xx with the same `{success:false, error_message}` body
      // as a 200 failure (measured 2026-09-15 on a 401). Only the reason phrase
      // reached the caller before — "HTTP 400: Bad Request" for a wrong carrier code.
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error_message: "Unknown carrier code: dhll" }));
      });

      try {
        const client = createTestClient("key", port);
        await client.addDelivery({ tracking_number: "1", carrier_code: "dhll", description: "x" });
        throw new Error("Should have thrown");
      } catch (err) {
        const error = err as Error & { code: string };
        expect(error.code).toBe("HTTP_ERROR");
        expect(error.message).toBe("HTTP 400: Unknown carrier code: dhll");
      } finally {
        await stopServer(server);
      }
    });

    it("keeps the INVALID_API_KEY classification on a 401 body and adds its text", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error_message: "Missing or invalid API key\nline two" }));
      });

      try {
        const client = createTestClient("key", port);
        await client.getDeliveries("active");
        throw new Error("Should have thrown");
      } catch (err) {
        const error = err as Error & { code: string };
        expect(error.code).toBe("INVALID_API_KEY");
        // Flattened like every other external text that reaches a log line.
        expect(error.message).toBe("HTTP 401: Missing or invalid API key line two");
      } finally {
        await stopServer(server);
      }
    });

    it("a non-string error_message is ignored, never thrown on (T4d)", async () => {
      const bodies = [JSON.stringify({ error_message: 42 }), JSON.stringify({})];
      let n = 0;
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(bodies[n++ % bodies.length]);
      });
      try {
        const client = createTestClient("key", port);
        for (const body of bodies) {
          await expect(client.getDeliveries("active"), body).rejects.toMatchObject({
            code: "HTTP_ERROR",
            message: "HTTP 400: Bad Request",
          });
        }
      } finally {
        await stopServer(server);
      }
    });

    it("an empty reason phrase is replaced by the standard one, never 'HTTP 502: ' (audit X1)", async () => {
      // A raw socket: Node's own HTTP server always fills in the standard reason phrase, so only a
      // hand-written status line can send the empty one a proxy may send.
      const raw = net.createServer(socket => {
        socket.once("data", () => {
          socket.end("HTTP/1.1 502 \r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        });
      });
      await new Promise<void>(resolve => raw.listen(0, "127.0.0.1", () => resolve()));
      const port = (raw.address() as AddressInfo).port;
      try {
        const client = createTestClient("key", port);
        await expect(client.getDeliveries("active")).rejects.toMatchObject({ message: "HTTP 502: Bad Gateway" });
      } finally {
        await new Promise<void>(resolve => raw.close(() => resolve()));
      }
    });

    it("falls back to the reason phrase when the non-2xx body is not that JSON object", async () => {
      const bodies = ["<html>Bad Gateway</html>", "", JSON.stringify(["nope"]), JSON.stringify({ error_message: "" })];
      let n = 0;
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(502, { "Content-Type": "text/html" });
        res.end(bodies[n++ % bodies.length]);
      });

      try {
        const client = createTestClient("key", port);
        for (const body of bodies) {
          try {
            await client.getDeliveries("active");
            throw new Error("Should have thrown");
          } catch (err) {
            const error = err as Error & { code: string };
            expect(error.code, body).toBe("HTTP_ERROR");
            expect(error.message, body).toBe("HTTP 502: Bad Gateway");
          }
        }
      } finally {
        await stopServer(server);
      }
    });

    it("should throw PARSE_ERROR on invalid JSON — and keep the body OUT of the message (S1)", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("not valid json{{{");
      });

      try {
        const client = createTestClient("key", port);
        await client.getDeliveries("active");
        throw new Error("Should have thrown");
      } catch (err) {
        const error = err as Error & { code: string };
        expect(error.message).toContain("JSON parse error");
        // v0.10.0 (M1): parse failures carry a machine code now.
        expect(error.code).toBe("PARSE_ERROR");
        // v0.10.0 (L26): the whole point of S1 — the (potentially PII-bearing)
        // raw body must NOT leak into the error-level message.
        expect(error.message).not.toContain("not valid json");
      } finally {
        await stopServer(server);
      }
    });
  });

  describe("getCarrierNames", () => {
    it("reads the carrier map in the shape parcel.app serves since 2026 — every value an object with `name`", async () => {
      // Recorded excerpt of the live file (2026-09-15, 304 entries): `extra_required`
      // and `name_variations` ride along and must not disturb the name lookup.
      const carriers = {
        dhl: { name: "DHL Express" },
        bpost: { name: "Bpost", extra_required: 1 },
        apple: { name: "Apple Store Orders", extra_required: 2 },
        blp: { name: "Belpost", name_variations: { ru: "Белпочта" } },
      };

      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(carriers));
      });

      try {
        const client = createTestClient("key", port);
        const result = await client.getCarrierNames();
        expect(result).toEqual({ dhl: "DHL Express", bpost: "Bpost", apple: "Apple Store Orders", blp: "Belpost" });
      } finally {
        await stopServer(server);
      }
    });

    it("still reads the pre-2026 plain-string form, and drops entries that carry no usable name", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            dhl: "DHL",
            ups: { name: "UPS" },
            broken: 123,
            nested: { x: 1 },
            empty: "",
            blank: { name: "" },
            list: ["DPD"],
            nothing: null,
          }),
        );
      });

      try {
        const client = createTestClient("key", port);
        const result = await client.getCarrierNames();
        expect(result).toEqual({ dhl: "DHL", ups: "UPS" });
      } finally {
        await stopServer(server);
      }
    });

    it("does NOT cache a map without a single usable entry — the next call fetches again", async () => {
      // This is exactly the defect of v0.9.0–v0.12.1: the format drift left the
      // filter with nothing, the empty object was cached as a success, and every
      // package showed its carrier code for the rest of the process.
      let calls = 0;
      const { server, port } = await startMockServer((_req, res) => {
        calls += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          calls === 1
            ? JSON.stringify({ dhl: { title: "DHL Express" }, ups: 7 })
            : JSON.stringify({ dhl: { name: "DHL Express" } }),
        );
      });

      try {
        const client = createTestClient("key", port);
        expect(await client.getCarrierNames()).toEqual({});
        expect(await client.getCarrierNames()).toEqual({ dhl: "DHL Express" });
        expect(calls).toBe(2);
        // …and the good map IS cached.
        expect(await client.getCarrierNames()).toEqual({ dhl: "DHL Express" });
        expect(calls).toBe(2);
      } finally {
        await stopServer(server);
      }
    });

    it("warns exactly once per process about an unreadable carrier list, then repeats at debug", async () => {
      const warned: string[] = [];
      const debugged: string[] = [];
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ dhl: { title: "DHL Express" } }));
      });

      try {
        const client = new ParcelClient(
          "key",
          testTimers,
          { debug: (m: string) => debugged.push(m), warn: (m: string) => warned.push(m) },
          `http://127.0.0.1:${port}/external`,
        );
        await client.getCarrierNames();
        await client.getCarrierNames();
        await client.getCarrierNames();
        expect(warned).toHaveLength(1);
        expect(warned[0]).toContain("carrier names unavailable");
        expect(debugged.filter(l => l.includes("carrier names unavailable"))).toHaveLength(2);
      } finally {
        await stopServer(server);
      }
    });

    it("without a warn logger the unreadable-list message goes to debug", async () => {
      const debugged: string[] = [];
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({}));
      });

      try {
        const client = new ParcelClient(
          "key",
          testTimers,
          { debug: (m: string) => debugged.push(m) },
          `http://127.0.0.1:${port}/external`,
        );
        expect(await client.getCarrierNames()).toEqual({});
        expect(debugged.filter(l => l.includes("carrier names unavailable"))).toHaveLength(1);
      } finally {
        await stopServer(server);
      }
    });

    it("v0.7.2: concurrent callers share a single in-flight fetch (mutex)", async () => {
      // The per-delivery updates run in Promise.all — without the mutex the
      // first poll with N packages fired N identical concurrent fetches.
      let callCount = 0;
      const { server, port } = await startMockServer((_req, res) => {
        callCount++;
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ dhl: "DHL" }));
        }, 30);
      });

      try {
        const client = createTestClient("key", port);
        const results = await Promise.all([
          client.getCarrierName("dhl"),
          client.getCarrierName("dhl"),
          client.getCarrierName("dhl"),
          client.getCarrierName("dhl"),
        ]);
        expect(results).toEqual(["DHL", "DHL", "DHL", "DHL"]);
        expect(callCount).toBe(1);
      } finally {
        await stopServer(server);
      }
    });

    it("v0.7.2: a failing fetch is shared too, and the next call retries fresh", async () => {
      let callCount = 0;
      const { server, port } = await startMockServer((_req, res) => {
        callCount++;
        if (callCount === 1) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Error");
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ dhl: "DHL" }));
        }
      });

      try {
        const client = createTestClient("key", port);
        // Concurrent failures share ONE request and all see the empty map.
        const [a, b] = await Promise.all([client.getCarrierNames(), client.getCarrierNames()]);
        expect(a).toEqual({});
        expect(b).toEqual({});
        expect(callCount).toBe(1);
        // Next call retries (failure was not cached) and succeeds.
        const c = await client.getCarrierNames();
        expect(c).toEqual({ dhl: "DHL" });
        expect(callCount).toBe(2);
      } finally {
        await stopServer(server);
      }
    });

    it("should cache carrier names after first call", async () => {
      let callCount = 0;
      const carriers = { dhl: "DHL" };

      const { server, port } = await startMockServer((_req, res) => {
        callCount++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(carriers));
      });

      try {
        const client = createTestClient("key", port);
        await client.getCarrierNames();
        await client.getCarrierNames();
        await client.getCarrierNames();
        expect(callCount).toBe(1);
      } finally {
        await stopServer(server);
      }
    });

    // The former "should return empty map on error without caching" lived here.
    // Removed 2026-08-22: a mutation test (cache the failure ⇒ no retry) turned
    // BOTH it and the v0.7.2 test above red, while removing the mutex turned only
    // the v0.7.2 one red — it was a strict subset with no defect of its own.

    it("should not send api-key header for carrier names", async () => {
      let receivedApiKey: string | undefined;

      const { server, port } = await startMockServer((req, res) => {
        receivedApiKey = req.headers["api-key"] as string | undefined;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({}));
      });

      try {
        const client = createTestClient("secret", port);
        await client.getCarrierNames();
        expect(receivedApiKey).toBeUndefined();
      } finally {
        await stopServer(server);
      }
    });
  });

  describe("getCarrierName", () => {
    it("should resolve carrier code to name", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ dhl: "DHL Express", ups: "UPS" }));
      });

      try {
        const client = createTestClient("key", port);
        const name = await client.getCarrierName("dhl");
        expect(name).toBe("DHL Express");
      } finally {
        await stopServer(server);
      }
    });

    it("should return uppercase code when not found in map", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ dhl: "DHL" }));
      });

      try {
        const client = createTestClient("key", port);
        const name = await client.getCarrierName("unknown_carrier");
        expect(name).toBe("UNKNOWN_CARRIER");
      } finally {
        await stopServer(server);
      }
    });
  });

  describe("addDelivery", () => {
    it("should POST delivery data", async () => {
      let receivedBody = "";
      let receivedMethod = "";

      const { server, port } = await startMockServer((req, res) => {
        receivedMethod = req.method || "";
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          receivedBody = Buffer.concat(chunks).toString("utf-8");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        });
      });

      try {
        const client = createTestClient("key", port);
        const result = await client.addDelivery({
          tracking_number: "123",
          carrier_code: "dhl",
          description: "Test",
        });

        expect(receivedMethod).toBe("POST");
        expect(result.success).toBe(true);
        const body = JSON.parse(receivedBody);
        expect(body.tracking_number).toBe("123");
        expect(body.carrier_code).toBe("dhl");
        expect(body.description).toBe("Test");
      } finally {
        await stopServer(server);
      }
    });

    it("should return error response", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        // Read body to prevent socket hang
        _req.on("data", () => {});
        _req.on("end", () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error_message: "Duplicate" }));
        });
      });

      try {
        const client = createTestClient("key", port);
        const result = await client.addDelivery({
          tracking_number: "123",
          carrier_code: "dhl",
          description: "Test",
        });
        expect(result.success).toBe(false);
        expect(result.error_message).toBe("Duplicate");
      } finally {
        await stopServer(server);
      }
    });
  });

  describe("API-drift guards", () => {
    it("should throw API_ERROR when deliveries is not an array", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, deliveries: "not-an-array" }));
      });

      try {
        const client = createTestClient("key", port);
        await client.getDeliveries("active");
        throw new Error("Should have thrown");
      } catch (err) {
        const error = err as Error & { code: string };
        expect(error.code).toBe("API_ERROR");
        expect(error.message).toContain("not an array");
      } finally {
        await stopServer(server);
      }
    });

    it("should return [] when deliveries is null (treated as empty, like absent)", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, deliveries: null }));
      });

      try {
        const client = createTestClient("key", port);
        const result = await client.getDeliveries("active");
        expect(result).toEqual([]);
      } finally {
        await stopServer(server);
      }
    });

    it("should throw API_ERROR when response is null", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("null");
      });

      try {
        const client = createTestClient("key", port);
        await client.getDeliveries("active");
        throw new Error("Should have thrown");
      } catch (err) {
        const error = err as Error & { code: string };
        expect(error.code).toBe("API_ERROR");
        expect(error.message).toContain("malformed");
      } finally {
        await stopServer(server);
      }
    });

    it("should throw API_ERROR when response is an array", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([1, 2, 3]));
      });

      try {
        const client = createTestClient("key", port);
        await client.getDeliveries("active");
        throw new Error("Should have thrown");
      } catch (err) {
        const error = err as Error & { code: string };
        expect(error.code).toBe("API_ERROR");
      } finally {
        await stopServer(server);
      }
    });

    it("should accept string 'true' as success (API drift)", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: "true", deliveries: [] }));
      });

      try {
        const client = createTestClient("key", port);
        const result = await client.getDeliveries("active");
        expect(result).toEqual([]);
      } finally {
        await stopServer(server);
      }
    });

    it("should accept number 1 as success (API drift)", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: 1, deliveries: [] }));
      });

      try {
        const client = createTestClient("key", port);
        const result = await client.getDeliveries("active");
        expect(result).toEqual([]);
      } finally {
        await stopServer(server);
      }
    });

    it("should reject 'false' string as success (API drift)", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: "false" }));
      });

      try {
        const client = createTestClient("key", port);
        await client.getDeliveries("active");
        throw new Error("Should have thrown");
      } catch (err) {
        const error = err as Error & { code: string };
        expect(error.code).toBe("API_ERROR");
      } finally {
        await stopServer(server);
      }
    });

    it("should handle a non-string error_message (API drift)", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: false,
            error_message: { nested: "object" },
          }),
        );
      });

      try {
        const client = createTestClient("key", port);
        await client.getDeliveries("active");
        throw new Error("Should have thrown");
      } catch (err) {
        const error = err as Error & { code: string };
        expect(error.code).toBe("API_ERROR");
        expect(error.message).toContain("UNKNOWN");
      } finally {
        await stopServer(server);
      }
    });

    it("should return empty map when carrier response is an array", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(["dhl", "ups"]));
      });

      try {
        const client = createTestClient("key", port);
        const result = await client.getCarrierNames();
        expect(result).toEqual({});
      } finally {
        await stopServer(server);
      }
    });

    it("should return empty map when carrier response is null", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("null");
      });

      try {
        const client = createTestClient("key", port);
        const result = await client.getCarrierNames();
        expect(result).toEqual({});
      } finally {
        await stopServer(server);
      }
    });

    it("getCarrierName should return UNKNOWN for non-string input", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ dhl: "DHL" }));
      });

      try {
        const client = createTestClient("key", port);
        const name1 = await client.getCarrierName(null);
        const name2 = await client.getCarrierName(42);
        const name3 = await client.getCarrierName(undefined);
        const name4 = await client.getCarrierName("");
        expect(name1).toBe("UNKNOWN");
        expect(name2).toBe("UNKNOWN");
        expect(name3).toBe("UNKNOWN");
        expect(name4).toBe("UNKNOWN");
      } finally {
        await stopServer(server);
      }
    });

    it("getCarrierName should fall back to uppercase code for an entry without a usable name", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ dhl: 42, ups: null, fedex: { name: "FedEx" } }));
      });

      try {
        const client = createTestClient("key", port);
        const dhl = await client.getCarrierName("dhl");
        const ups = await client.getCarrierName("ups");
        const fedex = await client.getCarrierName("fedex");
        expect(dhl).toBe("DHL");
        expect(ups).toBe("UPS");
        expect(fedex).toBe("FedEx");
      } finally {
        await stopServer(server);
      }
    });
  });

  describe("testConnection", () => {
    it("should return success when API responds", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, deliveries: [] }));
      });

      try {
        const client = createTestClient("valid-key", port);
        const result = await client.testConnection();
        expect(result.success).toBe(true);
        expect(result.message).toBe("Connection successful");
      } finally {
        await stopServer(server);
      }
    });

    it("should return failure for invalid API key", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("Unauthorised");
      });

      try {
        const client = createTestClient("bad-key", port);
        const result = await client.testConnection();
        expect(result.success).toBe(false);
        expect(result.message).toBe("Invalid API key");
      } finally {
        await stopServer(server);
      }
    });

    it("explains a 403 the same way the poll path does — Premium subscription or revoked key (v0.13.0)", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error_message: "Forbidden" }));
      });

      try {
        const client = createTestClient("key", port);
        const result = await client.testConnection();
        expect(result.success).toBe(false);
        expect(result.message).toBe(FORBIDDEN_HINT);
        expect(result.message).toContain("Premium");
      } finally {
        await stopServer(server);
      }
    });

    it("should return failure with error message for other errors", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Server Error");
      });

      try {
        const client = createTestClient("key", port);
        const result = await client.testConnection();
        expect(result.success).toBe(false);
        expect(result.message).toContain("500");
      } finally {
        await stopServer(server);
      }
    });
  });

  // -----------------------------------------------------------------------
  // v0.4.2 hardening — cancelAll
  // -----------------------------------------------------------------------

  describe("cancelAll (P1 v0.4.2)", () => {
    it("is idempotent and safe on an empty in-flight set", () => {
      const client = createTestClient("key", 0);
      // Stated explicitly: the contract is "never throws", however often it runs
      // and whether or not anything is in flight (onUnload may call it twice).
      expect(() => {
        client.cancelAll();
        client.cancelAll();
      }).not.toThrow();
    });

    it("aborts an in-flight request with the ABORTED code (M1)", async () => {
      // Hanging mock: never responds, so the request stays in-flight until aborted.
      const { server, port } = await startMockServer(() => {
        /* intentionally no response */
      });
      try {
        const client = createTestClient("key", port);
        const pending = client.getDeliveries("active");
        client.cancelAll();
        // v0.10.0 (M1): the shutdown abort carries a machine code so the
        // adapter routes it to debug instead of a red "Poll failed" line.
        await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
      } finally {
        await stopServer(server);
      }
    });

    it("is terminal: a request STARTED after cancelAll is refused immediately (L3)", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, deliveries: [] }));
      });
      try {
        const client = createTestClient("key", port);
        client.cancelAll();
        // No fresh connection may open during shutdown — e.g. the carrier
        // fetch kicked off by a poll batch that was already past getDeliveries.
        await expect(client.getDeliveries("active")).rejects.toMatchObject({ code: "ABORTED" });
      } finally {
        await stopServer(server);
      }
    });
  });

  describe("API-drift guards (2026-09-02 audit: entries and the add-delivery body)", () => {
    it.each([
      ["null entry", "[null]"],
      ["number entry", "[1]"],
      ["string entry", '["x"]'],
      ["nested array entry", "[[]]"],
    ])(
      "rejects a deliveries list with a non-object %s as API_ERROR instead of a TypeError deep in the poll",
      async (_label, entries) => {
        const { server, port } = await startMockServer((_req, res) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(`{"success":true,"deliveries":${entries}}`);
        });
        try {
          const client = createTestClient("key", port);
          await expect(client.getDeliveries("active")).rejects.toMatchObject({
            code: "API_ERROR",
            message: "API error: malformed delivery entry",
          });
        } finally {
          await stopServer(server);
        }
      },
    );

    it("keeps a well-formed list with several entries intact (the entry guard has no false positive)", async () => {
      const deliveries = [
        { carrier_code: "dhl", status_code: 2, tracking_number: "A" },
        { carrier_code: "ups", status_code: 4, tracking_number: "B" },
      ];
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, deliveries }));
      });
      try {
        const client = createTestClient("key", port);
        await expect(client.getDeliveries("active")).resolves.toEqual(deliveries);
      } finally {
        await stopServer(server);
      }
    });

    it.each([
      ["null", "null"],
      ["string", '"ok"'],
      ["array", "[]"],
      ["number", "1"],
    ])(
      "addDelivery rejects a %s body as API_ERROR — the script gets a clear error, not a TypeError",
      async (_label, body) => {
        const { server, port } = await startMockServer((req, res) => {
          req.on("data", () => {});
          req.on("end", () => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(body);
          });
        });
        try {
          const client = createTestClient("key", port);
          await expect(
            client.addDelivery({ tracking_number: "1", carrier_code: "dhl", description: "d" }),
          ).rejects.toMatchObject({ code: "API_ERROR", message: "API error: malformed response" });
        } finally {
          await stopServer(server);
        }
      },
    );
  });

  describe("API-drift guards (v0.10.0 additions)", () => {
    it("should throw API_ERROR when deliveries is a plain object (L22)", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, deliveries: {} }));
      });
      try {
        const client = createTestClient("key", port);
        await client.getDeliveries("active");
        throw new Error("Should have thrown");
      } catch (err) {
        // Present-but-wrong-typed deliveries is real drift — it must throw so
        // the poll keeps existing states instead of reading it as "empty" and
        // deleting every package (the 0.9.0 data-loss class).
        expect((err as Error & { code: string }).code).toBe("API_ERROR");
      } finally {
        await stopServer(server);
      }
    });

    it("flattens and caps a hostile error_message before it reaches the Error (M6)", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error_message: `line1\nFORGED second log line\n${"x".repeat(500)}` }));
      });
      try {
        const client = createTestClient("key", port);
        await client.getDeliveries("active");
        throw new Error("Should have thrown");
      } catch (err) {
        const error = err as Error & { code: string };
        expect(error.code).toBe("API_ERROR");
        expect(error.message).not.toContain("\n"); // flattened
        expect(error.message.length).toBeLessThan(250); // capped at the snippet length
      } finally {
        await stopServer(server);
      }
    });
  });

  // T1: these exercise the real request() transport hardening (retry-after
  // clamp, body-size cap, URL validation) that the old monkey-patch left
  // untested — and where the patch had even drifted from production.
  describe("transport hardening (T1)", () => {
    it("clamps an absurd Retry-After down to 24h (P6)", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(429, { "Content-Type": "text/plain", "Retry-After": "999999999" });
        res.end("Too many requests");
      });
      try {
        const client = createTestClient("key", port);
        await client.getDeliveries("active");
        throw new Error("Should have thrown");
      } catch (err) {
        const error = err as Error & { code: string; retryAfterSeconds: number };
        expect(error.code).toBe("RATE_LIMITED");
        expect(error.retryAfterSeconds).toBe(24 * 3600);
      } finally {
        await stopServer(server);
      }
    });

    it("rejects an oversized response body with BODY_TOO_LARGE (P9)", async () => {
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("x".repeat((1 << 20) + 16)); // > MAX_BODY_BYTES (1 MiB)
      });
      try {
        const client = createTestClient("key", port);
        await client.getDeliveries("active");
        throw new Error("Should have thrown");
      } catch (err) {
        expect((err as Error & { code: string }).code).toBe("BODY_TOO_LARGE");
      } finally {
        await stopServer(server);
      }
    });

    it("rejects an oversized body EXACTLY ONCE even if more chunks keep arriving (P9)", async () => {
      // A streaming endpoint keeps sending after the cap is hit. The already-
      // rejected promise must not be settled a second time and no further chunk
      // may be buffered — otherwise the memory guard would be pointless.
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        const chunk = "x".repeat(256 * 1024);
        for (let i = 0; i < 8; i++) {
          res.write(chunk); // crosses 1 MiB on the fifth chunk, keeps going
        }
        res.end();
      });
      try {
        const client = createTestClient("key", port);
        const outcomes: string[] = [];
        await client
          .getDeliveries("active")
          .then(() => outcomes.push("resolved"))
          .catch((err: Error & { code: string }) => outcomes.push(err.code));
        // Give the socket a moment to deliver any further chunk.
        await new Promise(resolve => setTimeout(resolve, 60));
        expect(outcomes).toEqual(["BODY_TOO_LARGE"]);
      } finally {
        await stopServer(server);
      }
    });

    it("rejects a malformed base URL with INVALID_URL (E3)", async () => {
      const client = new ParcelClient("key", testTimers, undefined, "not-a-valid-url");
      try {
        await client.getDeliveries("active");
        throw new Error("Should have thrown");
      } catch (err) {
        expect((err as Error & { code: string }).code).toBe("INVALID_URL");
      }
    });

    it("propagates a synchronous write failure as API_ERROR instead of stranding the request (I8)", async () => {
      // A body that JSON.stringify cannot serialize makes req.write throw
      // synchronously. Without the try/catch around write/end the rejection
      // would never happen AND the AbortController would stay in `inflight`,
      // breaking cancelAll's "inflight mirrors live requests" invariant.
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
      try {
        const client = createTestClient("key", port);
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        await expect(client.addDelivery(circular as never)).rejects.toMatchObject({ code: "API_ERROR" });
        // The failed request must not linger: a following cancelAll has nothing
        // left to abort, and a fresh request still works.
        client.cancelAll();
      } finally {
        await stopServer(server);
      }
    });
  });

  // -----------------------------------------------------------------------
  // The two watchdogs against a request that never finishes. Both used to be
  // untestable (15 s / 60 s) and therefore untested; the constructor now takes
  // millisecond overrides so a real server can drive both paths in <1 s.
  // -----------------------------------------------------------------------

  describe("request watchdogs", () => {
    it("aborts a silent connection with TIMEOUT once the socket idle timeout elapses", async () => {
      // Server accepts the request and then says nothing at all — the socket
      // goes quiet, which is exactly what the idle timeout is for.
      const { server, port } = await startMockServer(() => {
        /* deliberately never responds */
      });
      try {
        const client = new ParcelClient("key", testTimers, undefined, `http://127.0.0.1:${port}/external`, {
          idleMs: 120,
        });
        await expect(client.getDeliveries("active")).rejects.toMatchObject({
          code: "TIMEOUT",
          message: "Request timeout",
        });
      } finally {
        await stopServer(server);
      }
    });

    it("caps the TOTAL duration of a trickling response the idle timeout never sees (M4)", async () => {
      // A byte every 40 ms keeps resetting the socket idle timer, so only the
      // hard deadline can end this. Without it a trickling endpoint pins
      // `isPolling` forever and the poll loop stops silently until a restart.
      const timers: NodeJS.Timeout[] = [];
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        for (let i = 0; i < 40; i++) {
          timers.push(setTimeout(() => res.write(" "), i * 40));
        }
      });
      try {
        const client = new ParcelClient("key", testTimers, undefined, `http://127.0.0.1:${port}/external`, {
          idleMs: 5_000, // deliberately far above the trickle interval
          deadlineMs: 250,
        });
        const started = Date.now();
        await expect(client.getDeliveries("active")).rejects.toMatchObject({ code: "TIMEOUT" });
        // Ended by the deadline, not by the idle timer.
        expect(Date.now() - started).toBeLessThan(4_000);
      } finally {
        for (const t of timers) {
          clearTimeout(t);
        }
        await stopServer(server);
      }
    });

    it("the deadline stays silent once the request has finished (the `settled` guard)", async () => {
      // The guard's observable effect is the LOG: without it every fast request
      // still writes a "HTTP deadline …" line once its timer elapses, which
      // reads like a timeout that never happened. (`req.destroy()` on a finished
      // request is a no-op, so watching for a late rejection proves nothing —
      // that version of this test was itself blind, found by mutation.)
      const lines: string[] = [];
      const { server, port } = await startMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, deliveries: [] }));
      });
      try {
        // 400 ms is deliberately generous: the local mock answers in single-digit
        // milliseconds, so even a heavily loaded CI runner finishes long before
        // the deadline — a tighter value would make THIS test the flaky one.
        const client = new ParcelClient(
          "key",
          testTimers,
          { debug: (m: string) => lines.push(m) },
          `http://127.0.0.1:${port}/external`,
          { deadlineMs: 400 },
        );
        await expect(client.getDeliveries("active")).resolves.toEqual([]);
        // Outlive the deadline, then look at what it logged.
        await new Promise(resolve => setTimeout(resolve, 500));
        expect(lines.filter(l => l.includes("HTTP deadline"))).toEqual([]);
        // And the client is still fully usable afterwards.
        await expect(client.getDeliveries("active")).resolves.toEqual([]);
      } finally {
        await stopServer(server);
      }
    });
  });
});
