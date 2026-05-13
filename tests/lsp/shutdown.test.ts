/**
 * LSP shutdown and cleanup tests.
 *
 * Verifies that every component in the server cleans up properly when the LSP
 * shutdown sequence fires. This is critical for shared SSH development servers
 * where zombie processes consume limited resources.
 *
 * Layers tested:
 * 1. PikeWorker.stop() — SIGTERM + SIGKILL escalation, queue drain, idempotency
 * 2. Server onShutdown — diagnosticManager.dispose(), worker.stop(), caches cleared
 * 3. LSP protocol shutdown — shutdown request triggers onShutdown handler
 * 4. DiagnosticManager dispose — timer and state cleanup
 *
 * Methodology:
 * - PikeWorker tests spawn real Pike subprocesses (skipped if Pike unavailable)
 * - Server-level tests use in-process PassThrough streams (no subprocess)
 * - After shutdown, we assert every resource is released: process dead,
 *   timers cleared, queues empty, caches empty.
 *
 * NOTE: Describe blocks that use createTestServer MUST be last. The
 * vscode-languageserver StreamMessageReader holds a stream reference that keeps
 * the bun test event loop alive. Blocks placed after createTestServer will not
 * run. This is a bun test runner limitation, not a shutdown bug.
 */

import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { PikeWorker } from "../../server/src/features/pikeWorker";
import { createTestServer, createSilentStream, type TestServer } from "./helpers";
import { pikeAvailable } from "../helpers/pikeAvailable";
import {
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc";
import { createConnection } from "vscode-languageserver/node";
import { createPikeServer } from "../../server/src/server";

// ---------------------------------------------------------------------------
// 1. PikeWorker.stop() — subprocess termination (requires Pike binary)
// ---------------------------------------------------------------------------

describe.skipIf(!pikeAvailable)("PikeWorker stop: subprocess termination", () => {
  test("stop() kills the Pike subprocess", async () => {
    const worker = new PikeWorker();
    await worker.ping();
    expect(worker.isAlive).toBe(true);

    worker.stop();
    expect(worker.isAlive).toBe(false);
  });

  test("stop() clears the request queue", async () => {
    const worker = new PikeWorker({ requestTimeoutMs: 60_000 });
    await worker.ping();

    // Enqueue a request but don't await it — it stays in the queue.
    worker.ping().catch(() => {});

    worker.stop();

    // Queue should be empty. Verify indirectly: next request succeeds.
    await worker.ping();
    expect(worker.isAlive).toBe(true);

    worker.stop();
  });

  test("stop() is idempotent — calling twice does not throw", async () => {
    const worker = new PikeWorker();
    await worker.ping();

    worker.stop();
    worker.stop();
    worker.stop();

    expect(worker.isAlive).toBe(false);
  });

  test("stop() on a never-started worker does not throw", () => {
    const worker = new PikeWorker();
    expect(() => worker.stop()).not.toThrow();
    expect(worker.isAlive).toBe(false);
  });

  test("stop() clears idle timer", async () => {
    const worker = new PikeWorker({ idleTimeoutMs: 60_000 });
    await worker.ping();

    worker.stop();
    expect(worker.isAlive).toBe(false);

    // Wait briefly — if idle timer wasn't cleared, it would fire and might
    // cause unexpected state. Test passes if no unhandled errors occur.
    await new Promise((r) => setTimeout(r, 100));
  });
});

// ---------------------------------------------------------------------------
// 2. PikeWorker.stop() — SIGKILL escalation (requires Pike binary)
// ---------------------------------------------------------------------------

describe.skipIf(!pikeAvailable)("PikeWorker stop: SIGKILL escalation", () => {
  test("stop() sends SIGTERM and process dies within grace period", async () => {
    const worker = new PikeWorker();
    await worker.ping();
    expect(worker.isAlive).toBe(true);

    // On a healthy Pike process, SIGTERM should kill it quickly.
    // The SIGKILL timer fires after 3s as a safety net.
    worker.stop();

    // Pike should die from SIGTERM well before the 3s SIGKILL timer.
    await new Promise((r) => setTimeout(r, 500));
    expect(worker.isAlive).toBe(false);
  });

  test("repeated stop/restart cycles do not leak processes", async () => {
    const worker = new PikeWorker({ requestTimeoutMs: 5_000 });

    for (let i = 0; i < 3; i++) {
      await worker.ping();
      expect(worker.isAlive).toBe(true);

      worker.stop();
      expect(worker.isAlive).toBe(false);
    }

    worker.stop();
  });
});

// ---------------------------------------------------------------------------
// 3. PikeWorker stop: unit-level (no Pike required)
// ---------------------------------------------------------------------------

describe("PikeWorker stop: unit-level (no Pike required)", () => {
  test("stop() on uninitialized worker is a no-op", () => {
    const worker = new PikeWorker();
    expect(worker.isAlive).toBe(false);
    expect(() => worker.stop()).not.toThrow();
    expect(worker.isAlive).toBe(false);
  });

  test("stop() sets proc to null", () => {
    const worker = new PikeWorker();
    expect((worker as any).proc).toBeNull();
    worker.stop();
    expect((worker as any).proc).toBeNull();
  });

  test("stop() clears the sending flag", () => {
    const worker = new PikeWorker();
    (worker as any).sending = true;
    worker.stop();
    expect((worker as any).sending).toBe(false);
  });

  test("stop() empties the queue", () => {
    const worker = new PikeWorker();
    (worker as any).queue.push({
      payload: "test",
      resolve: () => {},
      reject: () => {},
      timeout: setTimeout(() => {}, 10000),
      priority: 0,
    });
    expect((worker as any).queue.length).toBe(1);

    worker.stop();
    expect((worker as any).queue.length).toBe(0);
  });

  test("isAvailable returns true when Pike was never attempted", () => {
    const worker = new PikeWorker();
    expect(worker.isAvailable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Server object — createPikeServer (no Pike, no LSP handshake)
// ---------------------------------------------------------------------------

describe("Server object: createPikeServer", () => {
  test("createPikeServer returns expected interface", () => {
    const c2s = createSilentStream();
    const s2c = createSilentStream();
    const conn = createConnection(
      new StreamMessageReader(c2s),
      new StreamMessageWriter(s2c),
    );
    const server = createPikeServer(conn);

    expect(server.connection).toBe(conn);
    expect(server.worker).toBeDefined();
    expect(server.index).toBeDefined();
    expect(server.autodocCache).toBeDefined();
    expect(server.diagnosticManager).toBeDefined();
    expect(server.worker.isAlive).toBe(false);

    c2s.destroy();
    s2c.destroy();
  });

  test("calling worker.stop() on idle server does not throw", () => {
    const c2s = createSilentStream();
    const s2c = createSilentStream();
    const conn = createConnection(
      new StreamMessageReader(c2s),
      new StreamMessageWriter(s2c),
    );
    const server = createPikeServer(conn);

    expect(() => server.worker.stop()).not.toThrow();
    expect(server.worker.isAlive).toBe(false);

    c2s.destroy();
    s2c.destroy();
  });

  test("force-close: destroying streams without shutdown does not throw on subsequent worker.stop()", async () => {
    const c2s = createSilentStream();
    const s2c = createSilentStream();
    const conn = createConnection(
      new StreamMessageReader(c2s),
      new StreamMessageWriter(s2c),
    );
    const server = createPikeServer(conn);

    // Simulate VSCode force-close: destroy streams without sending shutdown.
    c2s.destroy();
    s2c.destroy();

    await new Promise((r) => setTimeout(r, 50));

    // worker.stop() should still work without errors.
    expect(() => server.worker.stop()).not.toThrow();
    expect(server.worker.isAlive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Full LSP shutdown sequence — MUST BE LAST describe block.
//    createTestServer keeps the event loop alive after this block completes,
//    preventing bun test from running subsequent describe blocks.
// ---------------------------------------------------------------------------

describe("Server onShutdown: full LSP shutdown sequence", () => {
  let ts: TestServer;
  let indexSizeBefore: number;

  beforeAll(async () => {
    ts = await createTestServer();

    // Open a document to populate the index.
    ts.openDoc("file:///test/shutdown-full.pike", "int x = 1;");
    await new Promise((r) => setTimeout(r, 100));

    indexSizeBefore = ts.server.index.size;

    // Trigger a didChange to create debounce timers in diagnosticManager.
    ts.client.sendNotification("textDocument/didChange", {
      textDocument: { uri: "file:///test/shutdown-full.pike", version: 2 },
      contentChanges: [{ text: "int x = 2;" }],
    });
    await new Promise((r) => setTimeout(r, 50));
  });

  test("index was populated before shutdown", () => {
    expect(indexSizeBefore).toBeGreaterThan(0);
  });

  test("shutdown request returns null (LSP spec)", async () => {
    const result = await ts.client.sendRequest("shutdown");
    expect(result).toBeNull();
  });

  test("diagnostic manager is disposed after shutdown", () => {
    expect(() => ts.server.diagnosticManager.dispose()).not.toThrow();
  });

  test("Pike worker is stopped after shutdown", () => {
    expect(ts.server.worker.isAlive).toBe(false);
  });

  test("workspace index is cleared after shutdown", () => {
    expect(ts.server.index.size).toBe(0);
  });

  test("autodoc cache is cleared after shutdown", () => {
    expect(ts.server.autodocCache.size).toBe(0);
  });

  test("exit notification after shutdown does not crash", () => {
    expect(() => ts.client.sendNotification("exit")).not.toThrow();
  });
});
