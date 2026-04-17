import { expect } from "chai";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { ParcelClient } from "../src/lib/parcel-client";

/**
 * Helper: start a local HTTP server that returns predefined responses.
 * Returns the server and its base URL (http://127.0.0.1:<port>).
 */
function startMockServer(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; port: number }> {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as AddressInfo;
            resolve({ server, port: addr.port });
        });
    });
}

function stopServer(server: http.Server): Promise<void> {
    return new Promise((resolve) => {
        server.close(() => resolve());
    });
}

/**
 * Create a ParcelClient that talks to a local HTTP mock server instead of
 * the real parcel.app API. We achieve this by monkey-patching the private
 * `request` method to use `http` instead of `https` and point to localhost.
 */
function createTestClient(apiKey: string, port: number): ParcelClient {
    const client = new ParcelClient(apiKey);

    // Override the private request method to use our local HTTP server
    (client as unknown as Record<string, unknown>)["request"] = function <T>(
        method: string,
        path: string,
        authenticated: boolean,
        body?: unknown,
    ): Promise<T> {
        return new Promise((resolve, reject) => {
            const headers: Record<string, string> = {};
            if (authenticated) {
                headers["api-key"] = apiKey;
            }
            if (body) {
                headers["Content-Type"] = "application/json";
            }

            const options: http.RequestOptions = {
                hostname: "127.0.0.1",
                port,
                path: `/external${path}`,
                method,
                headers,
                timeout: 5000,
            };

            const req = http.request(options, (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (chunk: Buffer) => chunks.push(chunk));
                res.on("end", () => {
                    const raw = Buffer.concat(chunks).toString("utf-8");

                    if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
                        if (res.statusCode === 429) {
                            const retryAfter = parseInt(res.headers["retry-after"] || "", 10);
                            const err = new Error("Rate limit exceeded") as Error & {
                                code: string;
                                retryAfterSeconds: number;
                            };
                            err.code = "RATE_LIMITED";
                            err.retryAfterSeconds = retryAfter > 0 ? retryAfter : 5 * 60;
                            reject(err);
                            return;
                        }
                        const err = new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`) as Error & {
                            code: string;
                        };
                        err.code =
                            res.statusCode === 401 || res.statusCode === 403
                                ? "INVALID_API_KEY"
                                : "HTTP_ERROR";
                        reject(err);
                        return;
                    }

                    try {
                        resolve(JSON.parse(raw) as T);
                    } catch {
                        reject(new Error(`JSON parse error: ${raw.substring(0, 200)}`));
                    }
                });
            });

            req.on("timeout", () => {
                req.destroy();
                reject(new Error("Request timeout"));
            });
            req.on("error", (err) => reject(err));

            if (body) {
                req.write(JSON.stringify(body));
            }
            req.end();
        });
    };

    return client;
}

describe("ParcelClient", () => {
    describe("getDeliveries", () => {
        it("should return deliveries on success", async () => {
            const deliveries = [
                {
                    carrier_code: "dhl",
                    description: "Test Package",
                    status_code: "2",
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
                expect(result).to.deep.equal(deliveries);
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
                expect(result).to.deep.equal([]);
            } finally {
                await stopServer(server);
            }
        });

        it("should throw on API error with INVALID_API_KEY code", async () => {
            const { server, port } = await startMockServer((_req, res) => {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(
                    JSON.stringify({
                        success: false,
                        error_code: "INVALID_API_KEY",
                        error_message: "Invalid API key",
                    }),
                );
            });

            try {
                const client = createTestClient("bad-key", port);
                await client.getDeliveries("active");
                expect.fail("Should have thrown");
            } catch (err) {
                const error = err as Error & { code: string };
                expect(error.code).to.equal("INVALID_API_KEY");
                expect(error.message).to.include("Invalid API key");
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
                        error_code: "SOME_ERROR",
                        error_message: "Something went wrong",
                    }),
                );
            });

            try {
                const client = createTestClient("key", port);
                await client.getDeliveries("active");
                expect.fail("Should have thrown");
            } catch (err) {
                const error = err as Error & { code: string };
                expect(error.code).to.equal("API_ERROR");
                expect(error.message).to.include("Something went wrong");
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
                expect(receivedApiKey).to.equal("my-secret-key");
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
                expect(receivedPath).to.include("filter_mode=recent");
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
                expect(receivedPath).to.include("filter_mode=active");
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
                expect.fail("Should have thrown");
            } catch (err) {
                const error = err as Error & { code: string; retryAfterSeconds: number };
                expect(error.code).to.equal("RATE_LIMITED");
                expect(error.retryAfterSeconds).to.equal(120);
                expect(error.message).to.include("Rate limit");
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
                expect.fail("Should have thrown");
            } catch (err) {
                const error = err as Error & { code: string; retryAfterSeconds: number };
                expect(error.code).to.equal("RATE_LIMITED");
                expect(error.retryAfterSeconds).to.equal(300); // 5 * 60
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
                expect.fail("Should have thrown");
            } catch (err) {
                const error = err as Error & { code: string };
                expect(error.code).to.equal("INVALID_API_KEY");
            } finally {
                await stopServer(server);
            }
        });

        it("should detect invalid API key on 403", async () => {
            const { server, port } = await startMockServer((_req, res) => {
                res.writeHead(403, { "Content-Type": "text/plain" });
                res.end("Forbidden");
            });

            try {
                const client = createTestClient("key", port);
                await client.getDeliveries("active");
                expect.fail("Should have thrown");
            } catch (err) {
                const error = err as Error & { code: string };
                expect(error.code).to.equal("INVALID_API_KEY");
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
                expect.fail("Should have thrown");
            } catch (err) {
                const error = err as Error & { code: string };
                expect(error.code).to.equal("HTTP_ERROR");
                expect(error.message).to.include("500");
            } finally {
                await stopServer(server);
            }
        });

        it("should throw on invalid JSON response", async () => {
            const { server, port } = await startMockServer((_req, res) => {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end("not valid json{{{");
            });

            try {
                const client = createTestClient("key", port);
                await client.getDeliveries("active");
                expect.fail("Should have thrown");
            } catch (err) {
                const error = err as Error;
                expect(error.message).to.include("JSON parse error");
            } finally {
                await stopServer(server);
            }
        });
    });

    describe("getCarrierNames", () => {
        it("should return carrier map", async () => {
            const carriers = { dhl: "DHL", ups: "UPS", fedex: "FedEx" };

            const { server, port } = await startMockServer((_req, res) => {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(carriers));
            });

            try {
                const client = createTestClient("key", port);
                const result = await client.getCarrierNames();
                expect(result).to.deep.equal(carriers);
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
                expect(callCount).to.equal(1);
            } finally {
                await stopServer(server);
            }
        });

        it("should return empty map on error without caching", async () => {
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

                // First call fails — should return empty map
                const result1 = await client.getCarrierNames();
                expect(result1).to.deep.equal({});

                // Second call succeeds — not cached from failure
                const result2 = await client.getCarrierNames();
                expect(result2).to.deep.equal({ dhl: "DHL" });
                expect(callCount).to.equal(2);
            } finally {
                await stopServer(server);
            }
        });

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
                expect(receivedApiKey).to.be.undefined;
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
                expect(name).to.equal("DHL Express");
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
                expect(name).to.equal("UNKNOWN_CARRIER");
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

                expect(receivedMethod).to.equal("POST");
                expect(result.success).to.be.true;
                const body = JSON.parse(receivedBody);
                expect(body.tracking_number).to.equal("123");
                expect(body.carrier_code).to.equal("dhl");
                expect(body.description).to.equal("Test");
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
                expect(result.success).to.be.false;
                expect(result.error_message).to.equal("Duplicate");
            } finally {
                await stopServer(server);
            }
        });
    });

    describe("API-drift guards", () => {
        it("should return [] when deliveries is not an array", async () => {
            const { server, port } = await startMockServer((_req, res) => {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: true, deliveries: "not-an-array" }));
            });

            try {
                const client = createTestClient("key", port);
                const result = await client.getDeliveries("active");
                expect(result).to.deep.equal([]);
            } finally {
                await stopServer(server);
            }
        });

        it("should return [] when deliveries is null", async () => {
            const { server, port } = await startMockServer((_req, res) => {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: true, deliveries: null }));
            });

            try {
                const client = createTestClient("key", port);
                const result = await client.getDeliveries("active");
                expect(result).to.deep.equal([]);
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
                expect.fail("Should have thrown");
            } catch (err) {
                const error = err as Error & { code: string };
                expect(error.code).to.equal("API_ERROR");
                expect(error.message).to.include("malformed");
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
                expect.fail("Should have thrown");
            } catch (err) {
                const error = err as Error & { code: string };
                expect(error.code).to.equal("API_ERROR");
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
                expect(result).to.deep.equal([]);
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
                expect(result).to.deep.equal([]);
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
                expect.fail("Should have thrown");
            } catch (err) {
                const error = err as Error & { code: string };
                expect(error.code).to.equal("API_ERROR");
            } finally {
                await stopServer(server);
            }
        });

        it("should handle non-string error_code/error_message (API drift)", async () => {
            const { server, port } = await startMockServer((_req, res) => {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(
                    JSON.stringify({
                        success: false,
                        error_code: 42,
                        error_message: { nested: "object" },
                    }),
                );
            });

            try {
                const client = createTestClient("key", port);
                await client.getDeliveries("active");
                expect.fail("Should have thrown");
            } catch (err) {
                const error = err as Error & { code: string };
                expect(error.code).to.equal("API_ERROR");
                expect(error.message).to.include("UNKNOWN");
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
                expect(result).to.deep.equal({});
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
                expect(result).to.deep.equal({});
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
                expect(name1).to.equal("UNKNOWN");
                expect(name2).to.equal("UNKNOWN");
                expect(name3).to.equal("UNKNOWN");
                expect(name4).to.equal("UNKNOWN");
            } finally {
                await stopServer(server);
            }
        });

        it("getCarrierName should fall back to uppercase code for non-string map value", async () => {
            const { server, port } = await startMockServer((_req, res) => {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ dhl: 42, ups: null, fedex: "FedEx" }));
            });

            try {
                const client = createTestClient("key", port);
                const dhl = await client.getCarrierName("dhl");
                const ups = await client.getCarrierName("ups");
                const fedex = await client.getCarrierName("fedex");
                expect(dhl).to.equal("DHL");
                expect(ups).to.equal("UPS");
                expect(fedex).to.equal("FedEx");
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
                expect(result.success).to.be.true;
                expect(result.message).to.equal("Connection successful");
            } finally {
                await stopServer(server);
            }
        });

        it("should return failure for invalid API key", async () => {
            const { server, port } = await startMockServer((_req, res) => {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(
                    JSON.stringify({
                        success: false,
                        error_code: "INVALID_API_KEY",
                        error_message: "Invalid API key",
                    }),
                );
            });

            try {
                const client = createTestClient("bad-key", port);
                const result = await client.testConnection();
                expect(result.success).to.be.false;
                expect(result.message).to.equal("Invalid API key");
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
                expect(result.success).to.be.false;
                expect(result.message).to.include("500");
            } finally {
                await stopServer(server);
            }
        });
    });
});
