/**
 * Configuration change tests (US-023).
 *
 * Tests that didChangeConfiguration updates diagnostic manager settings.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestServer, type TestServer } from "./helpers";

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await server.teardown();
});

describe("US-023: didChangeConfiguration", () => {
  test("diagnostic mode changes on configuration update", async () => {
    // Verify initial mode is realtime
    expect(server.server.diagnosticManager.diagnosticMode).toBe("realtime");

    // Send configuration change
    await server.client.sendNotification("workspace/didChangeConfiguration", {
      settings: {
        pike: {
          languageServer: {
            diagnosticMode: "saveOnly",
          },
        },
      },
    });

    // Wait a tick for the handler to process
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(server.server.diagnosticManager.diagnosticMode).toBe("saveOnly");

    // Reset to realtime
    await server.client.sendNotification("workspace/didChangeConfiguration", {
      settings: {
        pike: {
          languageServer: {
            diagnosticMode: "realtime",
          },
        },
      },
    });

    await new Promise(resolve => setTimeout(resolve, 10));
    expect(server.server.diagnosticManager.diagnosticMode).toBe("realtime");
  });

  test("ignores invalid diagnostic mode", async () => {
    expect(server.server.diagnosticManager.diagnosticMode).toBe("realtime");

    await server.client.sendNotification("workspace/didChangeConfiguration", {
      settings: {
        pike: {
          languageServer: {
            diagnosticMode: "invalidMode",
          },
        },
      },
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    // Should remain unchanged
    expect(server.server.diagnosticManager.diagnosticMode).toBe("realtime");
  });

  test("empty configuration notification does not change settings", async () => {
    const modeBefore = server.server.diagnosticManager.diagnosticMode;

    await server.client.sendNotification("workspace/didChangeConfiguration", {
      settings: {},
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    expect(server.server.diagnosticManager.diagnosticMode).toBe(modeBefore);
  });
});
