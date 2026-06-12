/**
 * T047: Workspace symbol progress and cancellation (US2).
 *
 * When the client advertises window.workDoneProgress, the server must report
 * begin/report/end progress notifications for workspace/symbol so users see
 * "Indexing…" during lazy global preparation.
 *
 * RED state: workspace/symbol does not yet route through global query
 * preparation, so no progress notifications are sent. After T057/T058, the
 * handler will create a work-done-progress token and report begin/end.
 *
 * Lives in a separate file from workspaceSymbol.test.ts because that file uses
 * a module-scoped server with beforeAll/afterAll; creating additional server
 * instances in the same file causes stream lifecycle conflicts.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { createTestServer, type TestServer } from "./helpers";

describe("T047: workspace symbol progress and cancellation (US2)", () => {
  let ws: TestServer;

  afterAll(async () => {
    if (ws) await ws.teardown();
  });

  test("workspace/symbol reports workDoneProgress on global query", async () => {
    ws = await createTestServer({ workDoneProgress: true });

    ws.openDoc("file:///test/t047-progress.pike", [
      "class ProgressTest {",
      "  int value;",
      "}",
    ].join("\n"));

    // Allow the server to index the document.
    await new Promise(resolve => setTimeout(resolve, 100));

    // Request with a client-generated workDoneToken so progress flows back.
    await ws.client.sendRequest("workspace/symbol", {
      query: "ProgressTest",
      workDoneToken: "t047-token-1",
    });

    // The server should send at least begin + end.
    const begins = ws.progressEvents.filter(e => e.value.kind === "begin");
    const ends = ws.progressEvents.filter(e => e.value.kind === "end");
    expect(begins.length).toBeGreaterThanOrEqual(1);
    expect(ends.length).toBeGreaterThanOrEqual(1);
  });
});
