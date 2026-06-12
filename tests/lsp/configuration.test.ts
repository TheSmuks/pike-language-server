/**
 * Configuration validation tests for resource-resilience settings.
 *
 * Tests parseResourceConfig for:
 * - Default values when no settings provided
 * - Custom value parsing
 * - Out-of-range value clamping
 * - Invalid mode fallback
 * - Hysteresis enforcement (recovery < demotion)
 * - Null/undefined input handling
 */

import { describe, test, expect } from "bun:test";
import { parseResourceConfig, DEFAULT_RESOURCE_CONFIG } from "../../server/src/features/resourceConfiguration";

describe("parseResourceConfig: defaults", () => {
  test("empty input returns full default config", () => {
    const config = parseResourceConfig(undefined);
    expect(config.indexing.mode).toBe("openFiles");
    expect(config.indexing.maxFileSizeBytes).toBe(1_048_576);
    expect(config.indexing.dependencyClosureDepth).toBe(5);
    expect(config.indexing.dependencyClosureCount).toBe(200);
    expect(config.memory.budgetMb).toBe(512);
    expect(config.worker.requestTimeoutMs).toBe(5_000);
    expect(config.worker.heartbeatIntervalMs).toBe(10_000);
    expect(config.worker.watchdogTimeoutMs).toBe(60_000);
    expect(config.hibernation.idleThresholdMs).toBe(600_000);
  });

  test("null input returns defaults", () => {
    const config = parseResourceConfig(null);
    expect(config.indexing.mode).toBe(DEFAULT_RESOURCE_CONFIG.indexing.mode);
  });

  test("empty object returns defaults", () => {
    const config = parseResourceConfig({});
    expect(config.indexing.mode).toBe(DEFAULT_RESOURCE_CONFIG.indexing.mode);
  });
});

describe("parseResourceConfig: indexing mode", () => {
  test("accepts openFiles", () => {
    const config = parseResourceConfig({ indexingMode: "openFiles" });
    expect(config.indexing.mode).toBe("openFiles");
  });

  test("accepts full", () => {
    const config = parseResourceConfig({ indexingMode: "full" });
    expect(config.indexing.mode).toBe("full");
  });

  test("accepts auto", () => {
    const config = parseResourceConfig({ indexingMode: "auto" });
    expect(config.indexing.mode).toBe("auto");
  });

  test("invalid mode falls back to default (openFiles)", () => {
    const config = parseResourceConfig({ indexingMode: "invalidMode" });
    expect(config.indexing.mode).toBe("openFiles");
  });

  test("empty string falls back to default", () => {
    const config = parseResourceConfig({ indexingMode: "" });
    expect(config.indexing.mode).toBe("openFiles");
  });
});

describe("parseResourceConfig: ignore globs", () => {
  test("accepts array of strings", () => {
    const globs = ["**/vendor/**", "**/.git/**"];
    const config = parseResourceConfig({ indexIgnoreGlobs: globs });
    expect(config.indexing.ignoreGlobs).toEqual(globs);
  });

  test("filters non-string entries", () => {
    const config = parseResourceConfig({
      indexIgnoreGlobs: ["valid", 123 as any, null as any, "also-valid"],
    });
    expect(config.indexing.ignoreGlobs).toEqual(["valid", "also-valid"]);
  });

  test("non-array falls back to default empty array", () => {
    const config = parseResourceConfig({ indexIgnoreGlobs: "not-an-array" as any });
    expect(config.indexing.ignoreGlobs).toEqual([]);
  });
});

describe("parseResourceConfig: memory budget", () => {
  test("accepts valid budget", () => {
    const config = parseResourceConfig({ memoryBudgetMb: 1024 });
    expect(config.memory.budgetMb).toBe(1024);
  });

  test("clamps below minimum (64)", () => {
    const config = parseResourceConfig({ memoryBudgetMb: 10 });
    expect(config.memory.budgetMb).toBe(64);
  });

  test("clamps above maximum (8192)", () => {
    const config = parseResourceConfig({ memoryBudgetMb: 999_999 });
    expect(config.memory.budgetMb).toBe(8192);
  });

  test("non-number falls back to default", () => {
    const config = parseResourceConfig({ memoryBudgetMb: "lots" as any });
    expect(config.memory.budgetMb).toBe(512);
  });

  test("NaN falls back to default, not NaN", () => {
    const config = parseResourceConfig({ memoryBudgetMb: NaN });
    expect(Number.isFinite(config.memory.budgetMb)).toBe(true);
    expect(config.memory.budgetMb).toBe(512);
  });

  test("recovery threshold is less than demotion threshold (hysteresis)", () => {
    const config = parseResourceConfig({});
    expect(config.memory.recoveryThresholdFraction).toBeLessThan(config.memory.demotionThresholdFraction);
  });
});

describe("parseResourceConfig: worker settings", () => {
  test("clamps request timeout to valid range", () => {
    const tooLow = parseResourceConfig({ workerRequestTimeoutMs: 50 });
    expect(tooLow.worker.requestTimeoutMs).toBe(1_000);

    const tooHigh = parseResourceConfig({ workerRequestTimeoutMs: 999_999 });
    expect(tooHigh.worker.requestTimeoutMs).toBe(60_000);
  });

  test("clamps heartbeat interval", () => {
    const config = parseResourceConfig({ workerHeartbeatIntervalMs: 100 });
    expect(config.worker.heartbeatIntervalMs).toBe(1_000);
  });

  test("clamps watchdog timeout", () => {
    const tooLow = parseResourceConfig({ workerWatchdogTimeoutMs: 1_000 });
    expect(tooLow.worker.watchdogTimeoutMs).toBe(5_000);
  });

  test("clamps max consecutive failures", () => {
    const config = parseResourceConfig({ workerMaxConsecutiveFailures: 0 });
    expect(config.worker.maxConsecutiveFailures).toBe(1);
  });

  test("clamps backoff values", () => {
    const config = parseResourceConfig({
      workerBackoffInitialMs: 1,
      workerBackoffMaxMs: 10,
    });
    expect(config.worker.backoffInitialMs).toBe(100);
    expect(config.worker.backoffMaxMs).toBe(1_000);
  });
});

describe("parseResourceConfig: hibernation settings", () => {
  test("clamps idle threshold below minimum", () => {
    const config = parseResourceConfig({ hibernationIdleThresholdMs: 1_000 });
    expect(config.hibernation.idleThresholdMs).toBe(10_000);
  });

  test("clamps idle threshold above maximum", () => {
    const config = parseResourceConfig({ hibernationIdleThresholdMs: 999_999_999 });
    expect(config.hibernation.idleThresholdMs).toBe(86_400_000);
  });

  test("clamps sustained activity", () => {
    const tooHigh = parseResourceConfig({ hibernationSustainedActivityMs: 999_999_999 });
    expect(tooHigh.hibernation.sustainedActivityMs).toBe(600_000);
  });
});

describe("parseResourceConfig: max file size", () => {
  test("clamps below minimum", () => {
    const config = parseResourceConfig({ indexMaxFileSizeBytes: 100 });
    expect(config.indexing.maxFileSizeBytes).toBe(1024);
  });

  test("clamps above maximum (50MB)", () => {
    const config = parseResourceConfig({ indexMaxFileSizeBytes: 999_999_999 });
    expect(config.indexing.maxFileSizeBytes).toBe(50 * 1024 * 1024);
  });
});

describe("parseResourceConfig: dependency closure", () => {
  test("clamps depth", () => {
    const config = parseResourceConfig({ indexDependencyClosureDepth: 999 });
    expect(config.indexing.dependencyClosureDepth).toBe(20);
  });

  test("clamps count", () => {
    const config = parseResourceConfig({ indexDependencyClosureCount: 999_999 });
    expect(config.indexing.dependencyClosureCount).toBe(10_000);
  });
});
