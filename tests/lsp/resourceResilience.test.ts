/**
 * Resource-resilience startup tests (Phase 3, T027).
 *
 * Tests that the server can start against a bloated cache directory without
 * crashing or OOMing, and that the bounded-batch loading path handles
 * large caches gracefully.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadCache } from "../../server/src/features/persistentCache";

describe("US1: Bloated-cache startup (Phase 3)", () => {
  let bloatedDir: string;

  beforeEach(() => {
    bloatedDir = mkdtempSync(join(tmpdir(), "pike-lsp-bloated-"));
  });

  afterEach(() => {
    rmSync(bloatedDir, { recursive: true, force: true });
  });

  test("T027: loads cache with many entries without crashing", async () => {
    const wasmHash = "bloated-hash";
    const cacheDir = join(bloatedDir, ".pike-lsp", "cache");
    mkdirSync(cacheDir, { recursive: true });

    // Write 200 cache entries — exercises bounded-batch loading.
    for (let i = 0; i < 200; i++) {
      const entry = {
        uri: `file:///test/file${i}.pike`,
        version: 1,
        contentHash: `hash-${i}`,
        dependencies: [],
        symbolTable: {
          uri: `file:///test/file${i}.pike`,
          version: 1,
          declarations: [],
          references: [],
          scopes: [],
        },
      };
      writeFileSync(join(cacheDir, `hash-${i}.json`), JSON.stringify(entry));
    }

    writeFileSync(
      join(bloatedDir, ".pike-lsp", "cacheIndex.json"),
      JSON.stringify({ formatVersion: 2, wasmHash, entryCount: 200 }),
    );

    const loaded = await loadCache(bloatedDir, wasmHash);
    expect(loaded).not.toBeNull();
    expect(loaded!.length).toBe(200);
  });

  test("T027: cache with temp files from interrupted saves does not break load", async () => {
    const wasmHash = "temp-hash";
    const cacheDir = join(bloatedDir, ".pike-lsp", "cache");
    mkdirSync(cacheDir, { recursive: true });

    // Write valid entries alongside temp files (from interrupted atomic writes).
    writeFileSync(join(cacheDir, "valid-hash.json"), JSON.stringify({
      uri: "file:///test/valid.pike",
      version: 1,
      contentHash: "valid-hash",
      dependencies: [],
      symbolTable: {
        uri: "file:///test/valid.pike",
        version: 1,
        declarations: [],
        references: [],
        scopes: [],
      },
    }));

    // Temp files should be ignored.
    writeFileSync(join(cacheDir, "valid-hash.json.tmp.1234.5678"), "partial write");

    writeFileSync(
      join(bloatedDir, ".pike-lsp", "cacheIndex.json"),
      JSON.stringify({ formatVersion: 2, wasmHash, entryCount: 1 }),
    );

    const loaded = await loadCache(bloatedDir, wasmHash);
    expect(loaded).not.toBeNull();
    expect(loaded!.length).toBe(1);
    expect(loaded![0].uri).toBe("file:///test/valid.pike");
  });
});

// ---------------------------------------------------------------------------
// US3: Degraded-mode global-feature unavailability (Phase 5, T065)
//
// Goal: Verify that global features (workspace symbol, find references) return
// an explicit "temporarily unavailable under memory pressure" signal when the
// resource state is degraded — never partial or empty success.
//
// Methodology: Test the HeapPressureMonitor hysteresis (enter/exit degraded)
// and prepareGlobalQuery's degraded guard directly.
// ---------------------------------------------------------------------------

import { HeapPressureMonitor } from "../../server/src/features/resourceState";
import {
  prepareGlobalQuery,
  DegradedGlobalUnavailableError,
} from "../../server/src/features/workspaceResolution";
import type { MemoryBudget } from "../../server/src/features/resourceTypes";

const TEST_BUDGET: MemoryBudget = {
  budgetMb: 100,
  demotionThresholdFraction: 0.8,
  recoveryThresholdFraction: 0.5,
};

describe("US3: Heap-pressure monitor hysteresis (Phase 5, T065)", () => {
  test("T065: enters degraded above demotion threshold", () => {
    let pressureCalls = 0;
    const monitor = new HeapPressureMonitor(
      TEST_BUDGET,
      () => { pressureCalls++; },
      () => {},
      { getHeapUsedMb: () => 85 }, // 85% of 100 MB budget > 80% threshold
    );

    monitor.check();
    expect(monitor.isDegraded()).toBe(true);
    expect(pressureCalls).toBe(1);
  });

  test("T065: does not re-enter degraded when already degraded", () => {
    let pressureCalls = 0;
    const monitor = new HeapPressureMonitor(
      TEST_BUDGET,
      () => { pressureCalls++; },
      () => {},
      { getHeapUsedMb: () => 90 },
    );

    monitor.check();
    monitor.check();
    monitor.check();
    expect(pressureCalls).toBe(1); // Only fires once on the transition.
  });

  test("T065: exits degraded below recovery threshold (hysteresis)", () => {
    let recoveryCalls = 0;
    const letHeap = { mb: 90 };
    const monitor = new HeapPressureMonitor(
      TEST_BUDGET,
      () => {},
      () => { recoveryCalls++; },
      { getHeapUsedMb: () => letHeap.mb },
    );

    // Enter degraded.
    monitor.check();
    expect(monitor.isDegraded()).toBe(true);

    // Still above recovery threshold (55 MB > 50 MB) — no recovery.
    letHeap.mb = 55;
    monitor.check();
    expect(monitor.isDegraded()).toBe(true);

    // Below recovery threshold (40 MB < 50 MB) — recover.
    letHeap.mb = 40;
    monitor.check();
    expect(monitor.isDegraded()).toBe(false);
    expect(recoveryCalls).toBe(1);
  });

  test("T065: does not re-exit when already recovered", () => {
    let recoveryCalls = 0;
    const letHeap = { mb: 90 };
    const monitor = new HeapPressureMonitor(
      TEST_BUDGET,
      () => {},
      () => { recoveryCalls++; },
      { getHeapUsedMb: () => letHeap.mb },
    );

    monitor.check(); // enter degraded
    letHeap.mb = 30;
    monitor.check(); // exit
    monitor.check(); // already recovered — no re-fire
    expect(recoveryCalls).toBe(1);
  });
});

describe("US3: Degraded global feature unavailability (Phase 5, T065)", () => {
  test("T065: prepareGlobalQuery throws DegradedGlobalUnavailableError when degraded", async () => {
    // prepareGlobalQuery must reject when the degraded check returns true.
    await expect(
      prepareGlobalQuery({
        connection: null as never,
        index: null as never,
        workspaceRoot: "",
        isDegraded: () => true,
      }),
    ).rejects.toThrow(DegradedGlobalUnavailableError);
  });

  test("T065: DegradedGlobalUnavailableError has the standard message", () => {
    const err = new DegradedGlobalUnavailableError();
    expect(err.message).toContain("temporarily unavailable");
    expect(err.message).toContain("memory pressure");
  });
});
