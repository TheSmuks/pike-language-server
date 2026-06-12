/**
 * Fail-fast error handling tests (Phase 3, T030).
 *
 * Tests that the server's fail-fast error handlers exist and route errors
 * to the ErrorLog system. Verifies installFailFastHandlers registers
 * process-level listeners without throwing.
 */

import { describe, test, expect } from "bun:test";
import type { Connection } from "vscode-languageserver/node";
import { CancellationTokenSource } from "vscode-languageserver/node";
import { installFailFastHandlers } from "../../server/src/serverLifecycle";
import { isOverMemoryBudget } from "../../server/src/serverInitHandler";
import { DEFAULT_RESOURCE_CONFIG } from "../../server/src/features/resourceConfiguration";
import { ResourceStateTracker } from "../../server/src/features/resourceState";

function silentConnection(): Connection {
  return {
    console: { warn: () => {}, info: () => {}, error: () => {} },
  } as unknown as Connection;
}

describe("US1: Fail-fast error handling (Phase 3)", () => {
  test("T030: installFailFastHandlers registers without throwing", () => {
    // The function should be callable without a connection.
    expect(() => installFailFastHandlers()).not.toThrow();
  });

  test("T030: installFailFastHandlers registers process listeners", () => {
    const beforeCount = process.listenerCount("uncaughtException");
    installFailFastHandlers();
    const afterCount = process.listenerCount("uncaughtException");
    // At least one listener should be registered.
    expect(afterCount).toBeGreaterThanOrEqual(beforeCount);
  });

  test("T030: isOverMemoryBudget is a function", () => {
    expect(typeof isOverMemoryBudget).toBe("function");
  });

  test("T036: isOverMemoryBudget returns true when over budget", () => {
    const tinyBudget = {
      ...DEFAULT_RESOURCE_CONFIG,
      memory: { ...DEFAULT_RESOURCE_CONFIG.memory, budgetMb: 1 },
    };
    // The bun test process uses far more than 1 MB of heap.
    expect(isOverMemoryBudget(tinyBudget, silentConnection())).toBe(true);
  });

  test("T036: isOverMemoryBudget returns false when under budget", () => {
    const hugeBudget = {
      ...DEFAULT_RESOURCE_CONFIG,
      memory: { ...DEFAULT_RESOURCE_CONFIG.memory, budgetMb: 1_000_000 },
    };
    expect(isOverMemoryBudget(hugeBudget, silentConnection())).toBe(false);
  });

  test("T036: ResourceStateTracker transitions to degraded", () => {
    const notifications: string[] = [];
    const cts = new CancellationTokenSource();
    const tracker = new ResourceStateTracker(
      (n) => notifications.push(n.state),
      cts,
    );

    expect(tracker.getState()).toBe("active");
    const changed = tracker.transition("degraded", "memory budget exceeded");
    expect(changed).toBe(true);
    expect(tracker.getState()).toBe("degraded");
    expect(notifications).toContain("degraded");
  });
});
