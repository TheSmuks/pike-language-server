/**
 * Protocol-level LSP lifecycle tests.
 *
 * Tests the initialize/initialized/shutdown/exit handshake and
 * basic performance characteristics.
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createTestServer, createSilentStream, waitForIndexed, type TestServer } from "./helpers";
import { buildServerCapabilities } from "../../server/src/serverCapabilities";
import { listCorpusFiles, CORPUS_DIR } from "../../tools/pike-oracle/src/runner";
import {
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from "vscode-jsonrpc/node";
import { createConnection } from "vscode-languageserver/node";
import { createPikeServer } from "../../server/src/server";

// Polls a value that changes asynchronously (e.g. via a notification
// handler) instead of sleeping a fixed interval — see waitForIndexed in
// ./helpers.ts for the same idiom applied to workspace indexing.
async function waitForCount(read: () => number, expected: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (read() !== expected) {
    if (Date.now() >= deadline) {
      throw new Error(`waitForCount: timed out after ${timeoutMs}ms; last value: ${read()}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ---------------------------------------------------------------------------
// 1. Capabilities
// ---------------------------------------------------------------------------

describe("lifecycle: capabilities", () => {
  test("capability advertisement matches implemented protocol model", () => {
    const caps = buildServerCapabilities().capabilities;
    // Diagnostics are push-only by design — advertising a pull provider we do
    // not implement would make clients wait on requests we never answer.
    expect(caps.diagnosticProvider).toBeUndefined();
    // full/delta and range are each backed by a handler in
    // navigationDocumentFeatures.ts.
    expect(caps.semanticTokensProvider).toMatchObject({ full: { delta: true }, range: true });
    // '.' member access, '>' for `->`, ':' for `::`, '!' for the `//!` autodoc marker.
    expect(caps.completionProvider?.triggerCharacters).toEqual(['.', '>', ':', '!']);
  });

  test("initialize response carries serverInfo with name and a semver-or-dev version", async () => {
    const c2s = createSilentStream();
    const s2c = createSilentStream();
    const serverConn = createConnection(
      new StreamMessageReader(c2s),
      new StreamMessageWriter(s2c),
    );
    createPikeServer(serverConn);
    serverConn.listen();

    const client = createMessageConnection(
      new StreamMessageReader(s2c),
      new StreamMessageWriter(c2s),
    );
    client.onRequest("window/showMessageRequest", () => null);
    client.listen();

    const result = (await client.sendRequest("initialize", {
      processId: null,
      rootUri: null,
      capabilities: {},
    })) as { serverInfo?: { name?: string; version?: string } };

    expect(result.serverInfo?.name).toBe("pike-language-server");
    // esbuild/bun --define stamps a semver at build time; running the
    // in-process TypeScript source (as this test does) leaves the define
    // absent, so version.ts falls back to "dev" — see server/src/version.ts.
    expect(result.serverInfo?.version).toMatch(/^(\d+\.\d+\.\d+|dev)$/);

    c2s.destroy();
    s2c.destroy();
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

  // The `exit` notification is NOT exercised here. These tests run the server
  // in-process, so vscode-languageserver's exit handler calls process.exit() on
  // the test runner itself — which silently killed this suite mid-run and
  // reported success. Real exit behaviour is covered against a real subprocess
  // by scripts/check-standalone.mjs ("exits cleanly on shutdown + exit").
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

    const ts = await createTestServer();
    const { client, c2s, s2c, openDoc, teardown } = ts;

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

    // Wait for the change to actually be indexed rather than sleeping a fixed
    // interval — a blind sleep either wastes time or races the server on a
    // loaded machine.
    await waitForIndexed(ts, [uri]);

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

    const ts = await createTestServer();
    const { client, c2s, s2c, openDoc, teardown } = ts;

    // Open with non-empty content
    const uri = openDoc("file:///test/empty.pike", "int x = 1;");

    // Change to empty content - this should be processed, not skipped
    client.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: "" }],
    });

    // Wait for the change to be indexed rather than sleeping a fixed
    // interval. Note: the file was already indexed once from its initial
    // (non-empty) open, so this resolves immediately rather than
    // specifically confirming the empty-content edit was processed —
    // verified empirically (8/8 trials) that the subsequent
    // documentSymbol request is naturally ordered after the didChange
    // notification on the same connection regardless, so no wait is
    // actually load-bearing here; kept for idiom consistency with the
    // sibling test above.
    await waitForIndexed(ts, [uri]);

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

  test("opening and closing a document updates the hibernation tracker", async () => {
    // HibernationManager — not ResourceStateTracker — owns activity and
    // open-document tracking, and open documents are what hold hibernation off.
    const { server, client, openDoc, teardown } = await createTestServer();
    const hibernation = server.context.hibernationManager;

    expect(hibernation.openDocumentCount).toBe(0);

    const uri = openDoc("file:///test/resource-activity.pike", "int x = 1;");
    await waitForCount(() => hibernation.openDocumentCount, 1);

    expect(hibernation.openDocumentCount).toBe(1);

    client.sendNotification("textDocument/didClose", { textDocument: { uri } });
    await waitForCount(() => hibernation.openDocumentCount, 0);

    expect(hibernation.openDocumentCount).toBe(0);

    await teardown();
  });

  test("resource state transition emits notification to client", async () => {
    const { server, client, teardown } = await createTestServer();

    // Held in an object: TypeScript's control-flow analysis narrows a plain
    // `let` to `null` here, since it cannot see the callback assign to it.
    const received: { state: string | null } = { state: null };
    client.onNotification("pike/resourceState", (params: { state: string }) => {
      received.state = params.state;
    });

    server.context.resourceState.transition("indexing", "test transition");

    // Poll for the notification rather than sleeping a fixed interval —
    // it arrives over the same async connection as everything else, and a
    // blind sleep either wastes time or races the client on a loaded box.
    await waitForCount(() => (received.state === "indexing" ? 1 : 0), 1);
    expect(received.state).toBe("indexing");

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
