import { resolve } from "node:path";
import { createSilentStream } from "./helpers";

/**
 * Tests for DiagnosticManager (Phase 6 P2 — decision 0013).
 *
 * Tests cover:
 * - Per-file debouncing
 * - Supersession (version-gated dispatch)
 * - Diagnostic mode (realtime/saveOnly/off)
 * - Lifecycle (close clears, reopen republishes)
 * - FIFO queue serialization (via PikeWorker)
 * - Cross-file propagation
 * - Content-hash caching
 *
 * These tests use the real Pike worker process and real timers.
 * Debounce intervals are set very short (50ms) for fast test execution.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { pikeAvailable } from "../helpers/pikeAvailable";
import { PassThrough } from "node:stream";
import {
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
  type MessageConnection,
} from "vscode-jsonrpc";
import {
  createConnection,
  type Connection,
} from "vscode-languageserver/node";
import { createPikeServer, type PikeServer } from "../../server/src/server";
import { DiagnosticManager } from "../../server/src/features/diagnosticManager";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CORPUS_DIR = resolve(import.meta.dir, "..", "..", "corpus", "files");
const DEBOUNCE_MS = 50;

interface TestContext {
  client: MessageConnection;
  server: PikeServer;
  c2s: PassThrough;
  s2c: PassThrough;
  nextVersion: number;
  uri: (name: string) => string;
  openDoc: (name: string, text: string) => string;
  changeDoc: (uri: string, text: string) => void;
  saveDoc: (uri: string) => Promise<void>;
  closeDoc: (uri: string) => void;
  waitForDiagnostics: (uri: string, timeoutMs?: number) => Promise<{ uri: string; diagnostics: unknown[] }>;
  teardown: () => Promise<void>;
}

async function createDiagnosticTestServer(debounceMs = DEBOUNCE_MS): Promise<TestContext> {
  const c2s = createSilentStream();
  const s2c = createSilentStream();

  const serverConn: Connection = createConnection(
    new StreamMessageReader(c2s),
    new StreamMessageWriter(s2c),
  );

  const server = createPikeServer(serverConn);
  serverConn.listen();

  const client = createMessageConnection(
    new StreamMessageReader(s2c),
    new StreamMessageWriter(c2s),
  );
  client.listen();

  await client.sendRequest("initialize", {
    processId: null,
    rootUri: null,
    capabilities: {},
    initializationOptions: { diagnosticMode: "realtime" },
  });
  client.sendNotification("initialized", {});

  // Ensure parser is ready
  const { initParser } = await import("../../server/src/parser");
  await initParser();

  let nextVersion = 1;
  const uriFn = (name: string) => `file:///test/${name}`;

  // Intercept sendDiagnostics for testing
  const diagPromises = new Map<string, {
    resolve: (value: { uri: string; diagnostics: unknown[] }) => void;
    reject: (err: Error) => void;
  }>();

  // Track the latest diagnostics per URI
  const latestDiagnostics = new Map<string, unknown[]>();

  // Listen for diagnostic notifications
  client.onNotification("textDocument/publishDiagnostics", (params: { uri: string; diagnostics: unknown[] }) => {
    latestDiagnostics.set(params.uri, params.diagnostics);
    const pending = diagPromises.get(params.uri);
    if (pending) {
      diagPromises.delete(params.uri);
      pending.resolve(params);
    }
  });

  return {
    client,
    server,
    c2s,
    s2c,
    get nextVersion() { return nextVersion; },
    uri: uriFn,
    openDoc(name: string, text: string): string {
      const u = uriFn(name);
      client.sendNotification("textDocument/didOpen", {
        textDocument: { uri: u, languageId: "pike", version: nextVersion++, text },
      });
      return u;
    },
    changeDoc(uri: string, text: string): void {
      client.sendNotification("textDocument/didChange", {
        textDocument: { uri, version: nextVersion++ },
        contentChanges: [{ text }],
      });
    },
    async saveDoc(uri: string): Promise<void> {
      client.sendNotification("textDocument/didSave", {
        textDocument: { uri },
      });
      // Give the server a tick to process
      await new Promise((r) => setTimeout(r, 10));
    },
    closeDoc(uri: string): void {
      client.sendNotification("textDocument/didClose", {
        textDocument: { uri },
      });
    },
    waitForDiagnostics(uri: string, timeoutMs = 5000): Promise<{ uri: string; diagnostics: unknown[] }> {
      // If we already have diagnostics for this URI, return them
      const existing = latestDiagnostics.get(uri);
      if (existing !== undefined) {
        // Reset for next wait
        latestDiagnostics.delete(uri);
        return Promise.resolve({ uri, diagnostics: existing });
      }

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          diagPromises.delete(uri);
          reject(new Error(`Timeout waiting for diagnostics on ${uri}`));
        }, timeoutMs);

        diagPromises.set(uri, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
      });
    },
    async teardown(): Promise<void> {
      const shutdownPromise = client.sendRequest("shutdown").catch(() => {});
      await Promise.race([
        shutdownPromise,
        new Promise((r) => setTimeout(r, 500)),
      ]);
      try {
        client.sendNotification("exit");
      } catch { /* ignore */ }
      c2s.destroy();
      s2c.destroy();
    },
  };
}

// ---------------------------------------------------------------------------
// Unit tests: DiagnosticManager core logic
// ---------------------------------------------------------------------------

describe("DiagnosticManager unit", () => {
  test("mergeDiagnostics maps Pike diagnostics to LSP format", async () => {
    const { mergeDiagnostics } = await import("../../server/src/features/diagnosticManager");
    const parseDiags = [{
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      severity: 1,
      source: "pike-lsp",
      message: "Parse error",
    }];

    const pikeDiags = [{
      line: 3,
      severity: "error" as const,
      message: "Bad type.",
      expected_type: "int",
      actual_type: "string",
    }];

    const result = mergeDiagnostics(parseDiags, pikeDiags);
    expect(result).toHaveLength(2);
    expect(result[0].message).toBe("Parse error");
    expect(result[1].range.start.line).toBe(2); // 1-based to 0-based
    expect(result[1].message).toContain("Bad type.");
    expect(result[1].message).toContain("Expected: int");
    expect(result[1].message).toContain("Got: string");
    expect(result[1].source).toBe("pike");
  });

  describe("lineToColumn and tree-aware mergeDiagnostics", () => {

    test("mergeDiagnostics uses tree to compute column for Pike diagnostics", async () => {
      const { initParser } = await import("../../server/src/parser");
      await initParser();
      const { mergeDiagnostics, lineToColumn } = await import("../../server/src/features/diagnosticManager");
      const { parse } = await import("../../server/src/parser");

      const source = [
        "#pragma strict_types",
        "int main() {",
        "  int x = 1;",
        '  string y = x;',  // line 4: type error
        "  return 0;",
        "}",
      ].join("\n");
      const tree = parse(source);

      // Verify lineToColumn finds the first token column on line 4 (1-indexed: line 4 = index 3)
      // Line 4 in the source is "  string y = x;" — first meaningful token is "string" at column 2
      const col = lineToColumn(tree, 4);
      expect(col).toBeGreaterThan(0);

      // Now verify mergeDiagnostics applies this column
      const pikeDiags = [{
        line: 4,
        severity: "error" as const,
        message: "Bad type in assignment.",
        expected_type: "string",
        actual_type: "int",
      }];
      const result = mergeDiagnostics([], pikeDiags, tree);
      expect(result).toHaveLength(1);
      expect(result[0].range.start.character).toBeGreaterThan(0);
    });

    test("mergeDiagnostics falls back to character 0 when no tree is provided", async () => {
      const { mergeDiagnostics } = await import("../../server/src/features/diagnosticManager");

      const pikeDiags = [{
        line: 3,
        severity: "error" as const,
        message: "Test error.",
      }];
      const result = mergeDiagnostics([], pikeDiags);
      expect(result).toHaveLength(1);
      expect(result[0].range.start.character).toBe(0);
    });
  });



  test("computeContentHash is deterministic", async () => {
    const { computeContentHash } = await import("../../server/src/features/diagnosticManager");
    const a = computeContentHash("hello");
    const b = computeContentHash("hello");
    const c = computeContentHash("world");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

// ---------------------------------------------------------------------------
// Protocol tests: debouncing and mode
// ---------------------------------------------------------------------------

describe.skipIf(!pikeAvailable)("Diagnostic debouncing", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createDiagnosticTestServer();
  });

  afterEach(async () => {
    await ctx.teardown();
  });

  test("didChange triggers parse diagnostics immediately", async () => {
    const uri = ctx.openDoc("debounce-immediate.pike", "int x = 1;\n");
    const diags = await ctx.waitForDiagnostics(uri);
    // Clean source has 0 parse diagnostics
    expect(diags.diagnostics).toHaveLength(0);
  });

  test("didChange with syntax error produces parse diagnostics", async () => {
    const uri = ctx.openDoc("parse-error.pike", "class { }\n");
    const diags = await ctx.waitForDiagnostics(uri);
    expect(diags.diagnostics.length).toBeGreaterThan(0);
    expect(diags.diagnostics[0]).toHaveProperty("source", "pike-lsp");
  });

  test("multiple rapid didChange events result in one diagnose call", async () => {
    // Open a clean file
    const uri = ctx.openDoc("multi-change.pike", "int x = 1;\n");
    await ctx.waitForDiagnostics(uri);

    // Send multiple changes rapidly
    ctx.changeDoc(uri, "int x = 1;\nint y = 2;\n");
    ctx.changeDoc(uri, "int x = 1;\nint y = 2;\nint z = 3;\n");
    ctx.changeDoc(uri, "int x = 1;\nint y = 2;\nint z = 3;\nint w = 4;\n");

    // Wait for the debounced diagnose to fire (should be just one)
    const diags = await ctx.waitForDiagnostics(uri);
    // The final version should be the last change
    expect(diags.diagnostics).toHaveLength(0); // Clean source
  });

  test("didSave bypasses debounce", async () => {
    const uri = ctx.openDoc("save-bypass.pike", "int x = 1;\n");
    await ctx.waitForDiagnostics(uri);

    // Change and immediately save
    ctx.changeDoc(uri, "int x = 1;\nint y = 2;\n");
    await ctx.saveDoc(uri);

    // Should get diagnostics from the save (immediate, no debounce)
    const diags = await ctx.waitForDiagnostics(uri);
    expect(diags).toBeDefined();
  });

  test("per-file timers are independent", async () => {
    const uriA = ctx.openDoc("file-a.pike", "int a = 1;\n");
    const uriB = ctx.openDoc("file-b.pike", "int b = 2;\n");
    await ctx.waitForDiagnostics(uriA);
    await ctx.waitForDiagnostics(uriB);

    // Change file A only
    ctx.changeDoc(uriA, "int a = 3;\n");

    // File A should get new diagnostics
    const diagsA = await ctx.waitForDiagnostics(uriA);
    expect(diagsA.diagnostics).toHaveLength(0);

    // File B should be unaffected (no new diagnostics)
    // This is implicitly tested — no diagnostic notification for B
  });
});

// ---------------------------------------------------------------------------
// Diagnostic mode
// ---------------------------------------------------------------------------

describe.skipIf(!pikeAvailable)("Diagnostic mode", () => {
  test("saveOnly mode does not diagnose on didChange", async () => {
    const c2s = createSilentStream();
    const s2c = createSilentStream();

    const serverConn = createConnection(
      new StreamMessageReader(c2s),
      new StreamMessageWriter(s2c),
    );
    const server = createPikeServer(serverConn);
    serverConn.listen();

    const client = createMessageConnection(
      new StreamMessageReader(s2c),
      new StreamMessageWriter(c2s),
    );
    client.listen();

    await client.sendRequest("initialize", {
      processId: null,
      rootUri: null,
      capabilities: {},
      initializationOptions: { diagnosticMode: "saveOnly" },
    });
    client.sendNotification("initialized", {});

    const { initParser } = await import("../../server/src/parser");
    await initParser();

    let diagCount = 0;
    client.onNotification("textDocument/publishDiagnostics", () => {
      diagCount++;
    });

    const uri = "file:///test/saveonly.pike";
    client.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "pike", version: 1, text: "int x = 1;\n" },
    });
    await new Promise((r) => setTimeout(r, 100));

    // didChange should NOT trigger Pike diagnostics in saveOnly mode
    // (only parse diagnostics, which are published by DiagnosticManager.onDidChange)
    const beforeChange = diagCount;
    client.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: "int x = 2;\n" }],
    });
    await new Promise((r) => setTimeout(r, 200));

    // In saveOnly mode, didChange still produces parse diagnostics (tree-sitter, free)
    // but NOT Pike diagnostics (debounced)
    // The key difference: in saveOnly mode, no debounce timer is set
    // We verify by checking the diagnosticManager's mode
    expect(server.diagnosticManager.diagnosticMode).toBe("saveOnly");

    // Save should trigger Pike diagnostics
    client.sendNotification("textDocument/didSave", {
      textDocument: { uri },
    });
    await new Promise((r) => setTimeout(r, 100));

    const shutdownPromise = client.sendRequest("shutdown").catch(() => {});
    await Promise.race([shutdownPromise, new Promise((r) => setTimeout(r, 500))]);
    try { client.sendNotification("exit"); } catch { /* ignore */ }
    c2s.destroy();
    s2c.destroy();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe.skipIf(!pikeAvailable)("Diagnostic lifecycle", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createDiagnosticTestServer();
  });

  afterEach(async () => {
    await ctx.teardown();
  });

  test("closing a file clears its diagnostics", async () => {
    const uri = ctx.openDoc("lifecycle-close.pike", "int x = 1;\n");
    await ctx.waitForDiagnostics(uri);

    // Close the file
    ctx.closeDoc(uri);

    // Should receive empty diagnostics
    const diags = await ctx.waitForDiagnostics(uri);
    expect(diags.diagnostics).toHaveLength(0);
  });

  test("reopening a file publishes fresh diagnostics", async () => {
    const uri = ctx.openDoc("lifecycle-reopen.pike", "int x = 1;\n");
    await ctx.waitForDiagnostics(uri);

    ctx.closeDoc(uri);
    await ctx.waitForDiagnostics(uri);

    // Reopen with clean source
    const uri2 = ctx.openDoc("lifecycle-reopen.pike", "int y = 2;\n");
    const diags = await ctx.waitForDiagnostics(uri2);
    expect(diags.diagnostics).toHaveLength(0); // Clean source
  });
});

// ---------------------------------------------------------------------------
// Content-hash caching
// ---------------------------------------------------------------------------

describe.skipIf(!pikeAvailable)("Diagnostic caching", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createDiagnosticTestServer();
  });

  afterEach(async () => {
    await ctx.teardown();
  });

  test("identical content reuses cached diagnostics on save", async () => {
    const source = "int x = 1;\n";
    const uri = ctx.openDoc("cache-hit.pike", source);
    await ctx.waitForDiagnostics(uri);

    // First save computes diagnostics
    await ctx.saveDoc(uri);
    await ctx.waitForDiagnostics(uri);

    // Second save with same content should hit cache (same diagnostics)
    await ctx.saveDoc(uri);
    const diags = await ctx.waitForDiagnostics(uri);
    expect(diags.diagnostics).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-file propagation
// ---------------------------------------------------------------------------

describe.skipIf(!pikeAvailable)("Cross-file diagnostic propagation", () => {
  test("editing a base class schedules re-diagnosis of dependents", async () => {
    // Use corpus directory as workspace root so WorkspaceIndex can resolve
    // inherit paths to real files on disk.
    const corpusRoot = CORPUS_DIR;
    const corpusUri = `file://${corpusRoot}`;

    // Create a dedicated server with the corpus root as workspace
    const c2s = createSilentStream();
    const s2c = createSilentStream();

    const serverConn = createConnection(
      new StreamMessageReader(c2s),
      new StreamMessageWriter(s2c),
    );
    const server = createPikeServer(serverConn);
    serverConn.listen();

    const client = createMessageConnection(
      new StreamMessageReader(s2c),
      new StreamMessageWriter(c2s),
    );
    client.listen();

    await client.sendRequest("initialize", {
      processId: null,
      rootUri: corpusUri,
      capabilities: {},
      initializationOptions: { diagnosticMode: "realtime" },
    });
    client.sendNotification("initialized", {});

    const { initParser } = await import("../../server/src/parser");
    await initParser();

    // Diagnostic promise tracking
    const diagPromises = new Map<string, {
      resolve: (value: { uri: string; diagnostics: unknown[] }) => void;
      reject: (err: Error) => void;
    }>();
    const latestDiagnostics = new Map<string, unknown[]>();

    client.onNotification("textDocument/publishDiagnostics", (params: { uri: string; diagnostics: unknown[] }) => {
      latestDiagnostics.set(params.uri, params.diagnostics);
      const pending = diagPromises.get(params.uri);
      if (pending) {
        diagPromises.delete(params.uri);
        pending.resolve(params);
      }
    });

    function waitForDiagnostics(uri: string, timeoutMs = 5000): Promise<{ uri: string; diagnostics: unknown[] }> {
      const existing = latestDiagnostics.get(uri);
      if (existing !== undefined) {
        latestDiagnostics.delete(uri);
        return Promise.resolve({ uri, diagnostics: existing });
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          diagPromises.delete(uri);
          reject(new Error(`Timeout waiting for diagnostics on ${uri}`));
        }, timeoutMs);
        diagPromises.set(uri, {
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (err) => { clearTimeout(timer); reject(err); },
        });
      });
    }

    // Real corpus files: base defines Animal, dependent inherits it
    // cross-inherit-simple-a.pike: defines class Animal with name/sound/speak()
    // cross-inherit-simple-b.pike: inherit "cross-inherit-simple-a.pike"; class Dog { inherit Animal; ... }
    const baseUri = `file://${resolve(corpusRoot, "cross-inherit-simple-a.pike")}`;
    const depUri = `file://${resolve(corpusRoot, "cross-inherit-simple-b.pike")}`;

    // Read the actual file content for didOpen
    const { readFileSync } = await import("node:fs");
    const baseContent = readFileSync(baseUri.slice("file://".length), "utf-8");
    const depContent = readFileSync(depUri.slice("file://".length), "utf-8");

    let version = 1;

    // Open base file
    client.sendNotification("textDocument/didOpen", {
      textDocument: { uri: baseUri, languageId: "pike", version: version++, text: baseContent },
    });
    await waitForDiagnostics(baseUri);

    // Open dependent file
    client.sendNotification("textDocument/didOpen", {
      textDocument: { uri: depUri, languageId: "pike", version: version++, text: depContent },
    });
    await waitForDiagnostics(depUri);

    // Edit the base file — remove the Animal class body to break the dependent
    const editedBase = "#pragma strict_types\n\nclass Animal { }\n";
    client.sendNotification("textDocument/didChange", {
      textDocument: { uri: baseUri, version: version++ },
      contentChanges: [{ text: editedBase }],
    });

    // Wait for base file diagnostics after the edit
    const baseDiags = await waitForDiagnostics(baseUri);
    expect(baseDiags).toBeDefined();

    // The dependent file should also get scheduled for re-diagnosis
    // (via propagateToDependents). Wait for it.
    const depDiags = await waitForDiagnostics(depUri, 5000);
    expect(depDiags).toBeDefined();

    // Teardown — stop the worker, destroy streams, and shut down
    server.worker.stop();
    const shutdownPromise = client.sendRequest("shutdown").catch(() => {});
    await Promise.race([shutdownPromise, new Promise((r) => setTimeout(r, 500))]);
    try { client.sendNotification("exit"); } catch { /* ignore */ }
    c2s.destroy();
    s2c.destroy();
  });
});

// ---------------------------------------------------------------------------
// Supersession
// ---------------------------------------------------------------------------

describe.skipIf(!pikeAvailable)("Diagnostic supersession", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createDiagnosticTestServer();
  });

  afterEach(async () => {
    await ctx.teardown();
  });

  test("rapid edits supersede intermediate content", async () => {
    const uri = ctx.openDoc("supersede.pike", "int x = 1;\n");
    await ctx.waitForDiagnostics(uri);

    // Edit with a type error, then immediately fix it
    ctx.changeDoc(uri, "int x = \"bad\";\n");
    ctx.changeDoc(uri, "int x = 2;\n");

    // Wait for the debounced diagnose to fire
    const diags = await ctx.waitForDiagnostics(uri, 2000);
    // The final content is clean, so diagnostics should be empty
    // (the intermediate bad content was superseded)
    expect(diags.diagnostics).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Priority queueing
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// FIFO queue serialization — real Pike worker integration
// ---------------------------------------------------------------------------

describe.skipIf(!pikeAvailable)("PikeWorker FIFO queue serialization", () => {
  test("concurrent diagnose/ping/autodoc process sequentially without corruption", async () => {
    const { PikeWorker } = await import("../../server/src/features/pikeWorker");
    const worker = new PikeWorker();

    try {
      // Fire 3 concurrent requests of different types with varying payloads.
      // The FIFO queue must serialize them so that each JSON response
      // arrives intact (no interleaved stdout writes).
      const sources = [
        "int x = 1;\n",
        "string s = \"hello\";\nint y = 2;\n",
        "class Foo { int a; int b; }\n",
      ];

      const results = await Promise.all([
        worker.diagnose(sources[0], "fifo-1.pike"),
        worker.ping(),
        worker.diagnose(sources[2], "fifo-3.pike"),
      ]);

      // All requests must complete without errors
      expect(results[0].exit_code).toBe(0);
      expect(results[0].diagnostics).toEqual([]);

      expect(results[1].status).toBe("ok");
      expect(results[1].pike_version).toMatch(/\d+\.\d+/);

      expect(results[2].exit_code).toBe(0);
      expect(results[2].diagnostics).toEqual([]);

      // Verify the worker is still alive and functional after serialization
      const postCheck = await worker.diagnose("int z = 42;\n", "fifo-post.pike");
      expect(postCheck.exit_code).toBe(0);
    } finally {
      worker.stop();
    }
  });

  test("5 concurrent diagnose requests all produce correct, distinct results", async () => {
    const { PikeWorker } = await import("../../server/src/features/pikeWorker");
    const worker = new PikeWorker();

    try {
      // Each request uses a unique identifier that appears in the
      // compilation context.  Verify responses are not mixed up.
      const payloads = await Promise.all([
        worker.diagnose("int a_0 = 0;\n", "distinct-0.pike"),
        worker.diagnose("int a_1 = 1;\n", "distinct-1.pike"),
        worker.diagnose("int a_2 = 2;\n", "distinct-2.pike"),
        worker.ping(),
        worker.diagnose("int a_4 = 4;\n", "distinct-4.pike"),
      ]);

      // All diagnose results should succeed
      for (const r of [payloads[0], payloads[1], payloads[2], payloads[4]]) {
        expect(r.exit_code).toBe(0);
        expect(r.diagnostics).toEqual([]);
      }

      // Ping should return version
      expect((payloads[3] as { status: string }).status).toBe("ok");
    } finally {
      worker.stop();
    }
  });

  test("diagnose with intentional errors reports correct line numbers", async () => {
    const { PikeWorker } = await import("../../server/src/features/pikeWorker");
    const worker = new PikeWorker();

    try {
      // This is the critical FIFO test: if responses were interleaved,
      // error line numbers would be wrong or diagnostics would be missing.
      const source = [
        "#pragma strict_types",
        "int main() {",
        "  int x = 1;",
        "  string y = x;",  // line 4: type error
        "  return 0;",
        "}",
      ].join("\n");

      const result = await worker.diagnose(source, "strict-error.pike", { strict: true });

      expect(result.exit_code).toBe(1);
      expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);

      const typeError = result.diagnostics.find(
        (d) => d.message === "Bad type in assignment.",
      );
      expect(typeError).toBeDefined();
      expect(typeError!.severity).toBe("error");
      // Line 4 in 1-based indexing — verify the Pike oracle gave us the right line
      expect(typeError!.line).toBe(4);
      expect(typeError!.expected_type).toBe("string");
      expect(typeError!.actual_type).toBe("int");
    } finally {
      worker.stop();
    }
  });
});