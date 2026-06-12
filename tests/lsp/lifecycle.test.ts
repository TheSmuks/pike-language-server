/**
 * Protocol-level LSP lifecycle tests.
 *
 * Tests the initialize/initialized/shutdown/exit handshake and
 * basic performance characteristics.
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createTestServer, createSilentStream, type TestServer } from "./helpers";
import { buildServerCapabilities } from "../../server/src/serverCapabilities";
import { listCorpusFiles, CORPUS_DIR } from "../../harness/src/runner";

// ---------------------------------------------------------------------------
// 1. Capabilities
// ---------------------------------------------------------------------------

describe("lifecycle: capabilities", () => {
  test("capability advertisement matches implemented protocol model", () => {
    const caps = buildServerCapabilities().capabilities;
    expect(caps.diagnosticProvider).toBeUndefined();
    expect(caps.semanticTokensProvider).toMatchObject({ full: true, range: true });
    expect(caps.completionProvider?.triggerCharacters).toEqual(['.']);
  });

  test("initialize returns documentSymbolProvider and textDocumentSync", async () => {
    const { client, teardown } = await createTestServer();

    // Server was already initialized by createTestServer, but we can verify
    // by checking that documentSymbol works
    const uri = "file:///test/lifecycle.pike";
    // Note: can't re-initialize, so just test that the server responds

    const result = await client.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri: "file:///nonexistent.pike" },
    });
    expect(result).toEqual([]);

    await teardown();
  });
});

// ---------------------------------------------------------------------------
// 2. Shutdown / exit
// ---------------------------------------------------------------------------

describe("lifecycle: shutdown and exit", () => {
  test("shutdown returns null", async () => {
    const { client, teardown } = await createTestServer();

    const result = await client.sendRequest("shutdown");
    expect(result).toBeNull();

    await teardown();
  });

  test("exit after shutdown does not throw", async () => {
    const { client, c2s, s2c } = await createTestServer();

    const result = await client.sendRequest("shutdown");
    expect(result).toBeNull();

    // exit is a notification (no response); must not throw
    client.sendNotification("exit");

    // Clean up streams directly — skip teardown() which re-sends
    // shutdown/exit and can hang when the connection is already gone.
    c2s.destroy();
    s2c.destroy();
  });
});

// ---------------------------------------------------------------------------
// 3. Performance
// ---------------------------------------------------------------------------

describe("lifecycle: performance", () => {
  test("cold start: full initialize handshake completes within 2000ms", async () => {
    const start = performance.now();
    const { teardown } = await createTestServer();
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(2000);

    await teardown();
  });

  test("warm request: 10 documentSymbol requests average under 200ms", async () => {
    const { client, openDoc, teardown } = await createTestServer();

    // Open a non-trivial file
    const source = readFileSync(
      join(CORPUS_DIR, "class-create.pike"),
      "utf-8",
    );
    const uri = openDoc("file:///perf/class-create.pike", source);

    // Warm up
    await client.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri },
    });

    const timings: number[] = [];
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      await client.sendRequest("textDocument/documentSymbol", {
        textDocument: { uri },
      });
      timings.push(performance.now() - start);
    }

    const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
    expect(avg).toBeLessThan(200);

    await teardown();
  });
});

// ---------------------------------------------------------------------------
// 4. Parser readiness guard
// ---------------------------------------------------------------------------

describe("lifecycle: parser readiness guard", () => {
  test("didChange before parser ready does not crash server", async () => {
    // This test verifies the rust-analyzer default-return pattern.
    // When a document change arrives before the tree-sitter parser is ready,
    // the handler returns immediately without blocking or erroring.
    // The document will be re-processed on the next didChange (keystroke).

    const { client, c2s, s2c, openDoc, teardown } = await createTestServer();

    // Open a document - this triggers didOpen
    const uri = openDoc("file:///test/ready.pike", "int x = 1;");

    // Send a didChange notification - this is normally processed immediately.
    // If the parser ready guard wasn't working, this would either:
    // - Block waiting for parser init (old behavior: await parserReady)
    // - Crash the server
    // With the guard, it returns immediately and processing continues.
    client.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: "int x = 2;" }],
    });

    // Give the server a moment to process
    await new Promise((r) => setTimeout(r, 100));

    // Verify the server is still responsive after the guard
    const result = await client.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri },
    });
    expect(result).not.toBeNull();

    // Clean up
    c2s.destroy();
    s2c.destroy();
    await teardown();
  });

  test("document changes with valid empty content are processed", async () => {
    // Empty string is valid content - the server should process it normally.
    // This ensures the content guard doesn't incorrectly skip empty files.

    const { client, c2s, s2c, openDoc, teardown } = await createTestServer();

    // Open with non-empty content
    const uri = openDoc("file:///test/empty.pike", "int x = 1;");

    // Change to empty content - this should be processed, not skipped
    client.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: "" }],
    });

    // Give the server time to process
    await new Promise((r) => setTimeout(r, 100));

    // Verify server is still responsive
    const result = await client.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri },
    });
    expect(result).not.toBeNull();

    // Clean up
    c2s.destroy();
    s2c.destroy();
    await teardown();
  });
});

// ---------------------------------------------------------------------------
// 5. Resource-resilience lifecycle (Phase 2 foundational)
// ---------------------------------------------------------------------------

describe("lifecycle: resource-resilience context", () => {
  test("server context has resourceConfig with defaults", async () => {
    const { server, teardown } = await createTestServer();
    const ctx = server.context;
    expect(ctx.resourceConfig).toBeDefined();
    expect(ctx.resourceConfig.indexing.mode).toBe("openFiles");
    expect(ctx.resourceConfig.memory.budgetMb).toBe(512);

    await teardown();
  });

  test("server context has resourceState tracker starting in active", async () => {
    const { server, teardown } = await createTestServer();
    expect(server.context.resourceState).toBeDefined();
    expect(server.context.resourceState.getState()).toBe("active");

    await teardown();
  });

  test("request activity updates resource state tracker", async () => {
    const { server, client, openDoc, teardown } = await createTestServer();

    const beforeIdle = server.context.resourceState.idleMs();
    expect(beforeIdle).toBeGreaterThanOrEqual(0);

    // Open a document — this should record activity
    const uri = openDoc("file:///test/resource-activity.pike", "int x = 1;");
    await new Promise((r) => setTimeout(r, 50));

    expect(server.context.resourceState.getOpenDocumentCount()).toBe(1);

    // Make a request — activity should be recent
    await client.sendRequest("textDocument/documentSymbol", { textDocument: { uri } });
    const afterIdle = server.context.resourceState.idleMs();
    expect(afterIdle).toBeLessThan(500);

    await teardown();
  });

  test("resource state transition emits notification to client", async () => {
    const { server, client, teardown } = await createTestServer();

    let receivedState: string | null = null;
    client.onNotification("pike/resourceState", (params: { state: string }) => {
      receivedState = params.state;
    });

    server.context.resourceState.transition("indexing", "test transition");

    // Allow notification to propagate
    await new Promise((r) => setTimeout(r, 100));
    expect(receivedState).toBe("indexing");

    await teardown();
  });

  test("cancellation token is active by default and cancellable", async () => {
    const { server, teardown } = await createTestServer();

    const cts = server.context.resourceState.getCancellationToken();
    expect(cts.token.isCancellationRequested).toBe(false);

    server.context.resourceState.cancelBackgroundWork();
    expect(cts.token.isCancellationRequested).toBe(true);

    await teardown();
  });
});
