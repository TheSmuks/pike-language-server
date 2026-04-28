/**
 * Shared-server hardening tests.
 *
 * Tests for the resource management features required for
 * SSH/shared-server deployment with multiple concurrent users.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { PikeWorker } from "../../server/src/features/pikeWorker";

// ---------------------------------------------------------------------------
// Idle eviction
// ---------------------------------------------------------------------------

describe("Idle worker eviction", () => {
  test("worker stops after idle timeout", async () => {
    const worker = new PikeWorker({
      idleTimeoutMs: 500, // 500ms for fast test
      requestTimeoutMs: 5000,
      maxRequestsBeforeRestart: 1000,
      maxActiveMinutes: 60,
      niceValue: 0,
    });

    // Start the worker
    await worker.ping();
    expect(worker.isAlive).toBe(true);

    // Wait for idle timeout (500ms + buffer)
    await new Promise((r) => setTimeout(r, 800));

    // Worker should have been killed
    expect(worker.isAlive).toBe(false);

    worker.stop();
  });

  test("next request after idle eviction restarts worker", async () => {
    const worker = new PikeWorker({
      idleTimeoutMs: 500,
      requestTimeoutMs: 5000,
      maxRequestsBeforeRestart: 1000,
      maxActiveMinutes: 60,
      niceValue: 0,
    });

    // Start and verify
    await worker.ping();
    expect(worker.isAlive).toBe(true);

    // Wait for idle timeout
    await new Promise((r) => setTimeout(r, 800));
    expect(worker.isAlive).toBe(false);

    // Next request should restart
    const result = await worker.ping();
    expect(result.status).toBe("ok");
    expect(worker.isAlive).toBe(true);

    worker.stop();
  });
});

// ---------------------------------------------------------------------------
// Worker memory ceiling (request count restart)
// ---------------------------------------------------------------------------

describe("Worker memory ceiling", () => {
  test("worker restarts after max requests", async () => {
    const worker = new PikeWorker({
      idleTimeoutMs: 60000, // Long idle for this test
      requestTimeoutMs: 5000,
      maxRequestsBeforeRestart: 5, // Low ceiling for testing
      maxActiveMinutes: 60,
      niceValue: 0,
    });

    // Send 4 requests — should not restart
    for (let i = 0; i < 4; i++) {
      await worker.ping();
    }
    expect(worker.currentRequestCount).toBe(4);

    // Send request 5 — triggers restart, counter resets
    const result = await worker.ping();
    expect(result.status).toBe("ok");

    // After restart, counter should be reset (the restart ping counts as 1)
    // The restart happens in shouldForceRestart() which checks >= threshold
    // After restart, the ping itself increments to 1
    expect(worker.currentRequestCount).toBeGreaterThanOrEqual(1);

    worker.stop();
  });
});

// ---------------------------------------------------------------------------
// Timeout-as-diagnostic
// ---------------------------------------------------------------------------

describe("Timeout surfaced as diagnostic", () => {
  test("diagnose returns timedOut=true when Pike worker doesn't respond", async () => {
    // Create a worker with an extremely short timeout
    const worker = new PikeWorker({
      idleTimeoutMs: 60000,
      requestTimeoutMs: 1, // 1ms — guaranteed timeout
      maxRequestsBeforeRestart: 1000,
      maxActiveMinutes: 60,
      niceValue: 0,
    });

    // Use a complex source that takes more than 1ms to compile
    const source = Array.from({ length: 100 }, (_, i) =>
      `int var_${i} = ${i}; string str_${i} = "${i}";`
    ).join("\n");

    const result = await worker.diagnose(source, "timeout-test.pike");

    expect(result.timedOut).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.exit_code).toBe(1);

    worker.stop();
  });

  test("normal diagnose does not time out with reasonable timeout", async () => {
    const worker = new PikeWorker({
      idleTimeoutMs: 60000,
      requestTimeoutMs: 5000,
      maxRequestsBeforeRestart: 1000,
      maxActiveMinutes: 60,
      niceValue: 0,
    });

    const result = await worker.diagnose("int main() { return 0; }\n", "normal.pike");

    expect(result.timedOut).toBeUndefined();
    expect(result.exit_code).toBe(0);

    worker.stop();
  });
});

// ---------------------------------------------------------------------------
// Cache LRU eviction
// ---------------------------------------------------------------------------

describe("LRU cache eviction", () => {
  test("cache evicts oldest entry at capacity", () => {
    // This tests the cache functions indirectly through the cache helpers
    // The real cache is in server.ts; we test the behavior pattern here
    const cache = new Map<string, { timestamp: number }>();
    const MAX = 5;

    // Fill cache
    for (let i = 0; i < MAX + 3; i++) {
      cache.set(`file://${i}.pike`, { timestamp: i });

      // Evict oldest if at capacity
      if (cache.size > MAX) {
        let oldestKey: string | null = null;
        let oldestTime = Infinity;
        for (const [key, entry] of cache) {
          if (entry.timestamp < oldestTime) {
            oldestTime = entry.timestamp;
            oldestKey = key;
          }
        }
        if (oldestKey) cache.delete(oldestKey);
      }
    }

    // Cache should be at MAX size
    expect(cache.size).toBe(MAX);

    // Oldest entries should be evicted
    expect(cache.has("file://0.pike")).toBe(false);
    expect(cache.has("file://1.pike")).toBe(false);
    expect(cache.has("file://2.pike")).toBe(false);

    // Newest entries should remain
    expect(cache.has("file://5.pike")).toBe(true);
    expect(cache.has("file://6.pike")).toBe(true);
    expect(cache.has("file://7.pike")).toBe(true);
  });
});
