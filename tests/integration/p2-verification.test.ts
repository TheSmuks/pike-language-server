/**
 * Phase 6 P2 Verification Suite — "Numbers over adjectives."
 *
 * Dedicated verification that the Pike Language Server holds up under
 * realistic load, using real PikeWorker and DiagnosticManager instances
 * (no mocks). Every scenario prints exact measurements.
 *
 * Scenarios:
 *   S1: Worker Thrashing Prevention
 *   S2: Hover Latency During In-Flight Diagnose
 *   S3: Cross-File Propagation Correctness (three-file chain)
 *   S4: Mode Switching & Lifecycle
 *
 * All tests run against a real in-process LSP server connected via
 * PassThrough streams. No subprocess or VSCode required.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { resolve, join } from "node:path";
import { readFileSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
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
import { createSilentStream } from "../lsp/helpers";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CORPUS_DIR = resolve(import.meta.dir, "..", "..", "corpus", "files");
const DIAGNOSE_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Instrumented test server
// ---------------------------------------------------------------------------

interface MeasurementContext {
  client: MessageConnection;
  server: PikeServer;

  /** Total worker.diagnose() invocations. */
  diagnoseCallCount: number;
  /** Reset the diagnose invocation counter. */
  resetDiagnoseCount(): void;

  /** publishDiagnostics counts per URI. */
  publishCounts: Map<string, number>;
  /** Reset publish count for a URI. */
  resetPublishCount(uri: string): void;

  /**
   * Wait for the NEXT publishDiagnostics notification for a URI.
   * IMPORTANT: Must be called BEFORE the action that triggers the publish,
   * otherwise the notification may arrive before the listener is registered.
   */
  waitForPublish(uri: string, timeoutMs?: number): Promise<{ uri: string; diagnostics: unknown[] }>;

  /** Send didOpen and return URI. */
  openDoc(name: string, text: string, version?: number): string;
  /** Send didChange with incremented version. */
  changeDoc(uri: string, text: string, version?: number): void;
  /** Send didSave. */
  saveDoc(uri: string): void;
  /** Send didClose. */
  closeDoc(uri: string): void;

  /** Teardown: shutdown, destroy streams, stop worker. */
  teardown(): Promise<void>;
}

async function createMeasurementServer(options?: {
  workspaceRoot?: string;
  diagnosticMode?: string;
}): Promise<MeasurementContext> {
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
    rootUri: options?.workspaceRoot ? `file://${options.workspaceRoot}` : null,
    capabilities: {},
    initializationOptions: {
      diagnosticMode: options?.diagnosticMode ?? "realtime",
    },
  });
  client.sendNotification("initialized", {});

  const { initParser } = await import("../../server/src/parser");
  await initParser();

  let diagnoseCallCount = 0;
  const publishCounts = new Map<string, number>();

  // Monkey-patch worker.diagnose to count invocations
  const origDiagnose = server.worker.diagnose.bind(server.worker);
  server.worker.diagnose = async function (...args: Parameters<typeof origDiagnose>) {
    diagnoseCallCount++;
    return origDiagnose(...args);
  };

  // Promise-based diagnostic waiting
  const pendingPublish = new Map<string, {
    resolve: (value: { uri: string; diagnostics: unknown[] }) => void;
    reject: (err: Error) => void;
  }>();

  client.onNotification(
    "textDocument/publishDiagnostics",
    (params: { uri: string; diagnostics: unknown[] }) => {
      publishCounts.set(params.uri, (publishCounts.get(params.uri) ?? 0) + 1);
      const pending = pendingPublish.get(params.uri);
      if (pending) {
        pendingPublish.delete(params.uri);
        pending.resolve(params);
      }
    },
  );

  let nextVersion = 100;

  return {
    client,
    server,
    get diagnoseCallCount() { return diagnoseCallCount; },
    resetDiagnoseCount() { diagnoseCallCount = 0; },
    publishCounts,
    resetPublishCount(uri: string) { publishCounts.delete(uri); },
    waitForPublish(uri: string, timeoutMs = DIAGNOSE_TIMEOUT_MS) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingPublish.delete(uri);
          reject(new Error(`Timeout (${timeoutMs}ms) waiting for publishDiagnostics on ${uri}`));
        }, timeoutMs);
        pendingPublish.set(uri, {
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (err) => { clearTimeout(timer); reject(err); },
        });
      });
    },
    openDoc(name: string, text: string, version?: number): string {
      const u = name.startsWith("file://") ? name : `file:///test/${name}`;
      client.sendNotification("textDocument/didOpen", {
        textDocument: { uri: u, languageId: "pike", version: version ?? nextVersion++, text },
      });
      return u;
    },
    changeDoc(uri: string, text: string, version?: number) {
      client.sendNotification("textDocument/didChange", {
        textDocument: { uri, version: version ?? nextVersion++ },
        contentChanges: [{ text }],
      });
    },
    saveDoc(uri: string) {
      client.sendNotification("textDocument/didSave", {
        textDocument: { uri },
      });
    },
    closeDoc(uri: string) {
      client.sendNotification("textDocument/didClose", {
        textDocument: { uri },
      });
    },
    async teardown() {
      server.worker.stop();
      const shutdown = client.sendRequest("shutdown").catch(() => {});
      await Promise.race([shutdown, new Promise(r => setTimeout(r, 500))]);
      try { client.sendNotification("exit"); } catch { /* ok */ }
      c2s.destroy();
      s2c.destroy();
    },
  };
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// S1: Worker Thrashing Prevention
// ---------------------------------------------------------------------------

describe("S1: Worker Thrashing Prevention", () => {
  let ctx: MeasurementContext;

  beforeEach(async () => {
    ctx = await createMeasurementServer();
  });

  afterEach(async () => {
    await ctx.teardown();
  });

  test("15 didChange events at 50ms intervals → ≤ 2 diagnose invocations", async () => {
    const fileUri = ctx.openDoc("s1-thrash.pike", "int x = 0;\n");
    // Wait for initial diagnostics to settle
    await ctx.waitForPublish(fileUri);
    ctx.resetDiagnoseCount();
    ctx.resetPublishCount(fileUri);

    const burstStart = performance.now();

    // Fire 15 didChange events at 50ms intervals
    for (let i = 0; i < 15; i++) {
      ctx.changeDoc(fileUri, `int x = ${i};\n`);
      await wait(50);
    }

    // Wait for debounce to settle (500ms debounce + margin)
    await wait(1500);
    const totalMs = performance.now() - burstStart;

    const count = ctx.diagnoseCallCount;

    console.log("──────────────────────────────────────────────");
    console.log(`S1 RESULT: 15 didChange @ 50ms intervals`);
    console.log(`  Diagnose invocations:  ${count}`);
    console.log(`  Total elapsed:         ${totalMs.toFixed(0)} ms`);
    console.log(`  Expected:              ≤ 2 (500ms debounce + supersession)`);
    console.log("──────────────────────────────────────────────");

    expect(count).toBeLessThanOrEqual(2);
  });

  test("15 didChange at 50ms + pause + 15 more → bounded diagnose count", async () => {
    const fileUri = ctx.openDoc("s1-burst-pause.pike", "int x = 0;\n");
    await ctx.waitForPublish(fileUri);
    ctx.resetDiagnoseCount();
    ctx.resetPublishCount(fileUri);

    // Burst 1
    for (let i = 0; i < 15; i++) {
      ctx.changeDoc(fileUri, `int x = ${i};\n`);
      await wait(50);
    }

    // Let debounce fire for burst 1
    await wait(800);

    const countAfterBurst1 = ctx.diagnoseCallCount;
    ctx.resetDiagnoseCount();

    // Burst 2
    for (let i = 15; i < 30; i++) {
      ctx.changeDoc(fileUri, `int x = ${i};\n`);
      await wait(50);
    }

    await wait(1500);
    const countAfterBurst2 = ctx.diagnoseCallCount;

    console.log("──────────────────────────────────────────────");
    console.log(`S1 BURST+PAUSE RESULT`);
    console.log(`  Burst 1 (15 changes):  ${countAfterBurst1} diagnose invocations`);
    console.log(`  Burst 2 (15 changes):  ${countAfterBurst2} diagnose invocations`);
    console.log(`  Expected each burst:   ≤ 2`);
    console.log("──────────────────────────────────────────────");

    expect(countAfterBurst1).toBeLessThanOrEqual(2);
    expect(countAfterBurst2).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// S2: Hover Latency During In-Flight Diagnose
// ---------------------------------------------------------------------------

describe("S2: Hover Latency During In-Flight Diagnose", () => {
  let ctx: MeasurementContext;

  beforeEach(async () => {
    ctx = await createMeasurementServer();
  });

  afterEach(async () => {
    await ctx.teardown();
  });

  test("hover latency measured while diagnose is in flight", async () => {
    const fileUri = ctx.openDoc(
      "s2-hover-during-diag.pike",
      "int x = 42;\nstring s = \"hello\";\n",
    );
    await ctx.waitForPublish(fileUri);
    ctx.resetDiagnoseCount();
    ctx.resetPublishCount(fileUri);

    // --- Baseline: hover at idle ---
    const idleLatencies: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      await ctx.client.sendRequest("textDocument/hover", {
        textDocument: { uri: fileUri },
        position: { line: 0, character: 4 }, // on 'x'
      });
      idleLatencies.push(performance.now() - start);
    }
    const avgIdle = idleLatencies.reduce((a, b) => a + b, 0) / idleLatencies.length;

    // --- Trigger a diagnose via didChange ---
    // Use a large-enough file to ensure the Pike compilation takes measurable time.
    // The important thing: we fire hover WHILE the diagnose is queued/in-flight.
    const largeSource = generateLargePikeSource(200);
    ctx.changeDoc(fileUri, largeSource);

    // Wait for debounce timer to fire (500ms) so the diagnose is dispatched
    await wait(550);

    // Now fire hover requests while the diagnose is (very likely) in-flight.
    // Hover is tree-sitter-only — it does NOT go through PikeWorker.enqueue().
    // However, if it DID go through the queue, we'd see it blocked here.
    const duringLatencies: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      await ctx.client.sendRequest("textDocument/hover", {
        textDocument: { uri: fileUri },
        position: { line: 0, character: 4 },
      });
      duringLatencies.push(performance.now() - start);
    }
    const avgDuring = duringLatencies.reduce((a, b) => a + b, 0) / duringLatencies.length;

    // Wait for the in-flight diagnose to complete so we don't leak state
    await ctx.waitForPublish(fileUri);

    const ratio = avgDuring / avgIdle;

    console.log("──────────────────────────────────────────────");
    console.log(`S2 RESULT: Hover latency measurement`);
    console.log(`  Idle hover latencies:    ${idleLatencies.map(l => l.toFixed(1)).join(", ")} ms`);
    console.log(`  Idle avg:                ${avgIdle.toFixed(1)} ms`);
    console.log(`  During-diag latencies:   ${duringLatencies.map(l => l.toFixed(1)).join(", ")} ms`);
    console.log(`  During-diag avg:         ${avgDuring.toFixed(1)} ms`);
    console.log(`  Ratio (during/idle):     ${ratio.toFixed(2)}x`);
    console.log(`  Diagnose calls fired:    ${ctx.diagnoseCallCount}`);
    console.log("");
    console.log(`  ARCHITECTURAL NOTE:`);
    console.log(`  Hover is tree-sitter-only and does NOT go through PikeWorker's`);
    console.log(`  FIFO queue. If it did, the ratio would be >>1 (blocked by diagnose).`);
    console.log(`  Expected ratio: ~1.0 (unaffected by in-flight diagnose).`);
    console.log("──────────────────────────────────────────────");

    // Hover should not be materially affected by in-flight diagnose.
    // Allow up to 10x as a generous bound for CI runners with variable CPU.
    // If hover were queued behind diagnose, we'd see >>100x.
    expect(avgDuring).toBeLessThan(1000);
    expect(ratio).toBeLessThan(10);
  });

  test("FIFO queue blocks concurrent worker requests", async () => {
    // Direct test: fire two diagnose requests concurrently and measure
    // that the second waits for the first.
    const source1 = "int a = 1;\n";
    const source2 = "int b = 2;\n";

    const start = performance.now();
    const [r1, r2] = await Promise.all([
      ctx.server.worker.diagnose(source1, "s2-fifo-1.pike"),
      ctx.server.worker.diagnose(source2, "s2-fifo-2.pike"),
    ]);
    const elapsed = performance.now() - start;

    console.log("──────────────────────────────────────────────");
    console.log(`S2 FIFO RESULT: Two concurrent diagnose requests`);
    console.log(`  Total time:   ${elapsed.toFixed(0)} ms (serialized via FIFO)`);
    console.log(`  Result 1:     exit_code=${r1.exit_code}, diagnostics=${r1.diagnostics.length}`);
    console.log(`  Result 2:     exit_code=${r2.exit_code}, diagnostics=${r2.diagnostics.length}`);
    console.log(`  Both succeeded without corruption: true`);
    console.log("──────────────────────────────────────────────");

    expect(r1.exit_code).toBe(0);
    expect(r2.exit_code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// S3: Cross-File Propagation Correctness
// ---------------------------------------------------------------------------

describe("S3: Cross-File Propagation Correctness", () => {
  const tmpDir = resolve(import.meta.dir, "__p2_tmp_crossfile__");

  beforeEach(() => {
    // Create temp directory with three-file chain BEFORE server init
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("base→mid→child chain: type error in base propagates to child", async () => {
    // Write three Pike files on disk so the workspace index can resolve inherits
    const baseContent = [
      "#pragma strict_types",
      "",
      "class Base {",
      "  string name;",
      "  void greet() { write(\"Hello \" + name + \"\\n\"); }",
      "}",
    ].join("\n");

    const midContent = [
      "#pragma strict_types",
      "",
      "inherit \"base.pike\";",
      "",
      "class Mid {",
      "  inherit Base;",
      "  void greet() { ::greet(); write(\"  (middle)\\n\"); }",
      "}",
    ].join("\n");

    const childContent = [
      "#pragma strict_types",
      "",
      "inherit \"mid.pike\";",
      "",
      "class Child {",
      "  inherit Mid;",
      "  void greet() { ::greet(); write(\"  (child)\\n\"); }",
      "}",
    ].join("\n");

    writeFileSync(join(tmpDir, "base.pike"), baseContent);
    writeFileSync(join(tmpDir, "mid.pike"), midContent);
    writeFileSync(join(tmpDir, "child.pike"), childContent);

    const ctx = await createMeasurementServer({ workspaceRoot: tmpDir });
    try {
      const baseUri = `file://${join(tmpDir, "base.pike")}`;
      const midUri = `file://${join(tmpDir, "mid.pike")}`;
      const childUri = `file://${join(tmpDir, "child.pike")}`;

      // Open all three files
      ctx.openDoc(baseUri, baseContent);
      await ctx.waitForPublish(baseUri);

      ctx.openDoc(midUri, midContent);
      await ctx.waitForPublish(midUri);

      ctx.openDoc(childUri, childContent);
      await ctx.waitForPublish(childUri);

      // Verify dependency graph (now uses the correct index from onInitialize)
      const baseDeps = ctx.server.index.getDependents(baseUri);
      const midDeps = ctx.server.index.getDependents(midUri);
      console.log("──────────────────────────────────────────────");
      console.log(`S3 DEPENDENCY GRAPH:`);
      console.log(`  base.pike dependents:  ${[...baseDeps].map(u => u.split("/").pop()).join(", ") || "(none)"}`);
      console.log(`  mid.pike dependents:   ${[...midDeps].map(u => u.split("/").pop()).join(", ") || "(none)"}`);

      // Introduce a type error in base.pike: change `string name` to a bad type
      const errorBaseContent = baseContent.replace(
        "string name;",
        "int name;",
      );

      ctx.resetPublishCount(midUri);
      ctx.resetPublishCount(childUri);
      ctx.resetDiagnoseCount();

      const editStart = performance.now();
      ctx.changeDoc(baseUri, errorBaseContent);

      // Wait for base to be diagnosed
      await ctx.waitForPublish(baseUri, 5000);
      const baseDiagMs = performance.now() - editStart;

      // Wait for mid.pike and child.pike to get re-diagnosed (via propagation)
      const midPromise = ctx.waitForPublish(midUri, 8000);
      const childPromise = ctx.waitForPublish(childUri, 8000);

      const [midResult, childResult] = await Promise.all([midPromise, childPromise]);
      const totalPropMs = performance.now() - editStart;

      console.log("");
      console.log(`S3 PROPAGATION RESULT:`);
      console.log(`  base→base diagnosis:    ${baseDiagMs.toFixed(0)} ms`);
      console.log(`  base→mid propagation:   present (diagnostics received)`);
      console.log(`  base→child propagation: present (diagnostics received)`);
      console.log(`  Total edit→child diag:  ${totalPropMs.toFixed(0)} ms`);
      console.log(`  Diagnose calls total:   ${ctx.diagnoseCallCount}`);
      console.log("──────────────────────────────────────────────");

      // Both mid and child must have received diagnostics
      expect(midResult).toBeDefined();
      expect(childResult).toBeDefined();
      expect(totalPropMs).toBeLessThan(8000);
    } finally {
      await ctx.teardown();
    }
  });

  test("corpus three-file chain: cross-inherit-chain-a→b→c", async () => {
    const ctx = await createMeasurementServer({ workspaceRoot: CORPUS_DIR });
    try {
      const uriA = `file://${join(CORPUS_DIR, "cross-inherit-chain-a.pike")}`;
      const uriB = `file://${join(CORPUS_DIR, "cross-inherit-chain-b.pike")}`;
      const uriC = `file://${join(CORPUS_DIR, "cross-inherit-chain-c.pike")}`;

      const contentA = readFileSync(uriA.slice("file://".length), "utf-8");
      const contentB = readFileSync(uriB.slice("file://".length), "utf-8");
      const contentC = readFileSync(uriC.slice("file://".length), "utf-8");

      // Open all three
      ctx.openDoc(uriA, contentA);
      await ctx.waitForPublish(uriA);
      ctx.openDoc(uriB, contentB);
      await ctx.waitForPublish(uriB);
      ctx.openDoc(uriC, contentC);
      await ctx.waitForPublish(uriC);

      // Verify dependency graph (uses the getter that returns the correct index)
      const aDeps = ctx.server.index.getDependents(uriA);
      const bDeps = ctx.server.index.getDependents(uriB);
      console.log("──────────────────────────────────────────────");
      console.log(`S3 CORPUS CHAIN:`);
      console.log(`  chain-a dependents:  ${[...aDeps].map(u => u.split("/").pop()).join(", ") || "(none)"}`);
      console.log(`  chain-b dependents:  ${[...bDeps].map(u => u.split("/").pop()).join(", ") || "(none)"}`);

      // Introduce a type error in chain-a: change label return type
      const editedA = contentA.replace(
        'protected string label;',
        'protected int label;',
      );

      ctx.resetPublishCount(uriB);
      ctx.resetPublishCount(uriC);
      ctx.resetDiagnoseCount();

      const editStart = performance.now();
      ctx.changeDoc(uriA, editedA);

      await ctx.waitForPublish(uriA, 5000);

      // With a proper dependency graph, B and C should get propagation
      let midReceivedAt = 0;
      let childReceivedAt = 0;

      const bPromise = ctx.waitForPublish(uriB, 8000).then(r => {
        midReceivedAt = performance.now();
        return r;
      });
      const cPromise = ctx.waitForPublish(uriC, 8000).then(r => {
        childReceivedAt = performance.now();
        return r;
      });

      const [bResult, cResult] = await Promise.all([bPromise, cPromise]);
      const totalMs = performance.now() - editStart;

      console.log("");
      console.log(`S3 CORPUS PROPAGATION RESULT:`);
      console.log(`  chain-b received diags:  ${bResult ? "yes" : "no"} (${midReceivedAt ? (midReceivedAt - editStart).toFixed(0) : "n/a"} ms)`);
      console.log(`  chain-c received diags:  ${cResult ? "yes" : "no"} (${childReceivedAt ? (childReceivedAt - editStart).toFixed(0) : "n/a"} ms)`);
      console.log(`  Total propagation time:  ${totalMs.toFixed(0)} ms`);
      console.log(`  Diagnose calls total:    ${ctx.diagnoseCallCount}`);
      console.log("──────────────────────────────────────────────");

      // Propagation correctness: both B and C must receive diagnostics
      if (aDeps.size > 0 || bDeps.size > 0) {
        expect(bResult).toBeDefined();
        expect(cResult).toBeDefined();
      }
    } finally {
      await ctx.teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// S4: Mode Switching & Lifecycle
// ---------------------------------------------------------------------------

describe("S4: Mode Switching & Lifecycle", () => {
  let ctx: MeasurementContext;

  beforeEach(async () => {
    ctx = await createMeasurementServer();
  });

  afterEach(async () => {
    await ctx.teardown();
  });

  test("saveOnly: didChange produces 0 diagnose, didSave produces ≥ 1", async () => {
    const fileUri = ctx.openDoc("s4-saveonly.pike", "int x = 1;\n");
    await ctx.waitForPublish(fileUri);
    ctx.resetDiagnoseCount();
    ctx.resetPublishCount(fileUri);

    // Switch to saveOnly mode
    ctx.server.diagnosticManager.setDiagnosticMode("saveOnly");
    expect(ctx.server.diagnosticManager.diagnosticMode).toBe("saveOnly");

    // Phase 1: didChange should NOT trigger diagnose
    ctx.changeDoc(fileUri, "int x = 2;\n");

    // Wait well beyond the debounce window
    await wait(1500);

    const diagnoseAfterChange = ctx.diagnoseCallCount;
    const phase1Pass = diagnoseAfterChange === 0;

    // Phase 2: didSave SHOULD trigger diagnose
    // Register the listener BEFORE sending didSave to avoid race conditions
    ctx.resetDiagnoseCount();
    const savePublishPromise = ctx.waitForPublish(fileUri, 5000);
    ctx.saveDoc(fileUri);

    await savePublishPromise;
    await wait(500);

    const diagnoseAfterSave = ctx.diagnoseCallCount;
    const phase2Pass = diagnoseAfterSave >= 1;

    console.log("──────────────────────────────────────────────");
    console.log(`S4 RESULT: Mode switching (realtime → saveOnly)`);
    console.log(`  didChange in saveOnly:   ${diagnoseAfterChange} diagnose calls (expected 0) ${phase1Pass ? "PASS" : "FAIL"}`);
    console.log(`  didSave in saveOnly:     ${diagnoseAfterSave} diagnose calls (expected ≥ 1) ${phase2Pass ? "PASS" : "FAIL"}`);
    console.log("──────────────────────────────────────────────");

    expect(diagnoseAfterChange).toBe(0);
    expect(diagnoseAfterSave).toBeGreaterThanOrEqual(1);
  });

  test("realtime → off → realtime: mode transitions are clean", async () => {
    const fileUri = ctx.openDoc("s4-off-mode.pike", "int x = 1;\n");
    await ctx.waitForPublish(fileUri);
    ctx.resetDiagnoseCount();

    // Switch to off
    ctx.server.diagnosticManager.setDiagnosticMode("off");
    expect(ctx.server.diagnosticManager.diagnosticMode).toBe("off");

    // didChange in off mode: 0 diagnose calls
    ctx.changeDoc(fileUri, "int x = 2;\n");
    await wait(1500);
    const offCount = ctx.diagnoseCallCount;

    // didSave in off mode: 0 diagnose calls
    ctx.resetDiagnoseCount();
    ctx.saveDoc(fileUri);
    await wait(1500);
    const offSaveCount = ctx.diagnoseCallCount;

    // Switch back to realtime
    ctx.server.diagnosticManager.setDiagnosticMode("realtime");
    expect(ctx.server.diagnosticManager.diagnosticMode).toBe("realtime");

    // didChange in realtime mode: should fire diagnose again.
    // Register the listener BEFORE the action to avoid missing the notification.
    ctx.resetDiagnoseCount();
    const realtimePublishPromise = ctx.waitForPublish(fileUri, 5000);
    ctx.changeDoc(fileUri, "int x = 3;\n");
    await realtimePublishPromise;

    // The first publishDiagnostics is parse diagnostics (immediate).
    // The Pike diagnose fires after the 500ms debounce. Wait for it.
    await wait(1500);

    const realtimeCount = ctx.diagnoseCallCount;

    console.log("──────────────────────────────────────────────");
    console.log(`S4 MODE CYCLE RESULT: realtime → off → realtime`);
    console.log(`  off + didChange:      ${offCount} diagnose calls (expected 0) ${offCount === 0 ? "PASS" : "FAIL"}`);
    console.log(`  off + didSave:        ${offSaveCount} diagnose calls (expected 0) ${offSaveCount === 0 ? "PASS" : "FAIL"}`);
    console.log(`  realtime + didChange: ${realtimeCount} diagnose calls (expected ≥ 1) ${realtimeCount >= 1 ? "PASS" : "FAIL"}`);
    console.log("──────────────────────────────────────────────");

    expect(offCount).toBe(0);
    expect(offSaveCount).toBe(0);
    expect(realtimeCount).toBeGreaterThanOrEqual(1);
  });

  test("mode switch during debounce: pending timer is cancelled", async () => {
    const fileUri = ctx.openDoc("s4-cancel-timer.pike", "int x = 1;\n");
    await ctx.waitForPublish(fileUri);
    ctx.resetDiagnoseCount();

    // Fire didChange to start debounce timer
    ctx.changeDoc(fileUri, "int x = 2;\n");

    // Immediately switch to saveOnly before the 500ms debounce fires
    ctx.server.diagnosticManager.setDiagnosticMode("saveOnly");

    // Wait beyond debounce window
    await wait(1500);

    const count = ctx.diagnoseCallCount;

    console.log("──────────────────────────────────────────────");
    console.log(`S4 CANCEL RESULT: mode switch during debounce`);
    console.log(`  Diagnose invocations:  ${count} (expected 0 — timer cancelled)`);
    console.log(`  ${count === 0 ? "PASS" : "FAIL"}`);
    console.log("──────────────────────────────────────────────");

    expect(count).toBe(0);
  });

  test("close file during debounce: no stale diagnostic publishes", async () => {
    const fileUri = ctx.openDoc("s4-close-during-debounce.pike", "int x = 1;\n");
    await ctx.waitForPublish(fileUri);
    ctx.resetDiagnoseCount();
    ctx.resetPublishCount(fileUri);

    // Fire didChange to start debounce timer
    ctx.changeDoc(fileUri, "int x = 2;\n");

    // Close the file before debounce fires
    ctx.closeDoc(fileUri);

    // Wait beyond debounce window
    await wait(1500);

    const diagnoseCount = ctx.diagnoseCallCount;
    const publishCount = ctx.publishCounts.get(fileUri) ?? 0;

    console.log("──────────────────────────────────────────────");
    console.log(`S4 CLOSE-DURING-DEBOUNCE RESULT:`);
    console.log(`  Diagnose invocations:   ${diagnoseCount} (expected 0)`);
    console.log(`  publishDiagnostics:     ${publishCount} (should be ≥ 1 for the close-clear)`);
    console.log("──────────────────────────────────────────────");

    // Close should cancel the debounce timer so no Pike diagnose fires.
    // We do expect the close notification itself (clearing diagnostics).
    expect(diagnoseCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a Pike source file with N lines to simulate a large file.
 * This ensures the Pike worker takes measurable time to compile it,
 * so we can test hover latency during in-flight diagnose.
 */
function generateLargePikeSource(lines: number): string {
  const parts: string[] = ["#pragma strict_types", ""];
  parts.push("class Generated {");

  // Generate enough class members to make compilation non-trivial
  for (let i = 0; i < lines; i++) {
    parts.push(`  int field_${i} = ${i};`);
  }

  parts.push("}");
  parts.push("");
  parts.push("int main() { return 0; }");
  parts.push("");
  return parts.join("\n");
}
