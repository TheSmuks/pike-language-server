/**
 * Resource-state notification and tracker tests.
 *
 * Tests ResourceStateTracker for:
 * - State transitions emit pike/resourceState notifications
 * - No notification on same-state transition
 * - Activity tracking (recordActivity, idleMs)
 * - Open document count tracking
 * - Cancellation token lifecycle
 * - Fake clock integration
 *
 * Tests the LSP notification path via an in-process server.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { CancellationTokenSource } from "vscode-languageserver/node";
import { ResourceStateTracker, sampleResourceMetrics } from "../../server/src/features/resourceState";
import { resourceMetricsLabel, setResourceState, getResourceMetrics } from "../../client/resourceNotificationState";
import type { ResourceStateNotification } from "../../server/src/features/resourceTypes";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTracker(): {
  tracker: ResourceStateTracker;
  notifications: ResourceStateNotification[];
} {
  const notifications: ResourceStateNotification[] = [];
  const cts = new CancellationTokenSource();
  const tracker = new ResourceStateTracker((n) => notifications.push(n), cts);
  return { tracker, notifications };
}

// ---------------------------------------------------------------------------
// State transition tests
// ---------------------------------------------------------------------------

describe("ResourceStateTracker: transitions", () => {
  test("starts in active state", () => {
    const { tracker } = createTracker();
    expect(tracker.getState()).toBe("active");
  });

  test("transition to new state sends notification", () => {
    const { tracker, notifications } = createTracker();
    tracker.transition("indexing", "background scan started");
    expect(notifications).toHaveLength(1);
    expect(notifications[0].state).toBe("indexing");
    expect(notifications[0].detail).toBe("background scan started");
    expect(tracker.getState()).toBe("indexing");
  });

  test("transition to same state does not send notification", () => {
    const { tracker, notifications } = createTracker();
    tracker.transition("active");
    expect(notifications).toHaveLength(0);
  });

  test("multiple transitions send multiple notifications", () => {
    const { tracker, notifications } = createTracker();
    tracker.transition("indexing");
    tracker.transition("degraded", "memory pressure");
    tracker.transition("active", "recovered");
    expect(notifications).toHaveLength(3);
    expect(notifications[0].state).toBe("indexing");
    expect(notifications[1].state).toBe("degraded");
    expect(notifications[2].state).toBe("active");
  });

  test("transition returns true on change, false on no-change", () => {
    const { tracker } = createTracker();
    expect(tracker.transition("degraded")).toBe(true);
    expect(tracker.transition("degraded")).toBe(false);
  });

  test("hibernation lifecycle: active → hibernating → hibernated → waking → active", () => {
    const { tracker, notifications } = createTracker();
    tracker.transition("hibernating");
    tracker.transition("hibernated");
    tracker.transition("waking");
    tracker.transition("active");
    expect(notifications.map((n) => n.state)).toEqual([
      "hibernating",
      "hibernated",
      "waking",
      "active",
    ]);
  });
});

// Activity and open-document tracking are owned by HibernationManager, not
// this tracker — see tests/lsp/hibernation.test.ts.

// ---------------------------------------------------------------------------
// Cancellation tests
// ---------------------------------------------------------------------------

describe("ResourceStateTracker: cancellation", () => {
  test("getCancellationToken returns active token", () => {
    const { tracker } = createTracker();
    const cts = tracker.getCancellationToken();
    expect(cts.token.isCancellationRequested).toBe(false);
  });

  test("cancelBackgroundWork cancels the token", () => {
    const { tracker } = createTracker();
    const cts = tracker.getCancellationToken();
    expect(cts.token.isCancellationRequested).toBe(false);
    tracker.cancelBackgroundWork();
    expect(cts.token.isCancellationRequested).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fake clock tests
// ---------------------------------------------------------------------------

describe("ResourceStateTracker: fake clock", () => {
  afterEach(() => {
    delete process.env.PIKE_LSP_FAKE_CLOCK_MS;
  });

  test("respects PIKE_LSP_FAKE_CLOCK_MS for notification timestamps", () => {
    process.env.PIKE_LSP_FAKE_CLOCK_MS = "1000000";
    const { tracker, notifications } = createTracker();

    tracker.transition("degraded", "fake clock");
    expect(notifications[0].timestamp).toBe(1_000_000);

    // Advance fake clock — the next transition stamps the new time.
    process.env.PIKE_LSP_FAKE_CLOCK_MS = "1005000";
    tracker.transition("active", "fake clock");
    expect(notifications[1].timestamp).toBe(1_005_000);
  });
});

// ---------------------------------------------------------------------------
// T096: Status-bar resource-state notification details
// ---------------------------------------------------------------------------

describe("US5: Status-bar resource-state details (Phase 7, T096)", () => {
  test("degraded transition includes detail string", () => {
    const { tracker, notifications } = createTracker();
    tracker.transition("degraded", "memory budget exceeded (450MB/512MB)");
    expect(notifications).toHaveLength(1);
    expect(notifications[0].state).toBe("degraded");
    expect(notifications[0].detail).toContain("memory budget");
  });

  test("hibernating transition includes idle detail", () => {
    const { tracker, notifications } = createTracker();
    tracker.transition("hibernating", "idle timeout (15min, 0 open docs)");
    expect(notifications[0].state).toBe("hibernating");
    expect(notifications[0].detail).toContain("idle timeout");
  });

  test("waking transition includes detail", () => {
    const { tracker, notifications } = createTracker();
    tracker.transition("hibernating");
    tracker.transition("hibernated");
    tracker.transition("waking", "request received — rehydrating");
    expect(notifications[2].state).toBe("waking");
    expect(notifications[2].detail).toContain("rehydrating");
  });

  test("active recovery transition includes detail", () => {
    const { tracker, notifications } = createTracker();
    tracker.transition("degraded", "pressure");
    tracker.transition("active", "heap pressure resolved");
    expect(notifications[1].state).toBe("active");
    expect(notifications[1].detail).toContain("resolved");
  });

  test("notification includes timestamp field", () => {
    const { tracker, notifications } = createTracker();
    tracker.transition("degraded", "test");
    expect(notifications[0]).toHaveProperty("timestamp");
    expect(typeof notifications[0].timestamp).toBe("number");
  });

  test("notification includes heap, RSS, and CPU metrics", () => {
    const { tracker, notifications } = createTracker();
    tracker.transition("degraded", "resource pressure");

    expect(notifications[0].heapMb).toBeGreaterThan(0);
    expect(notifications[0].rssMb).toBeGreaterThan(0);
    expect(notifications[0].cpuUserMs).toBeGreaterThanOrEqual(0);
    expect(notifications[0].cpuSystemMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Resource process metrics tests
// ---------------------------------------------------------------------------

describe("Resource metrics sampling", () => {
  test("sampleResourceMetrics reports heap, RSS, and CPU fields", () => {
    const metrics = sampleResourceMetrics();

    expect(metrics.heapMb).toBeGreaterThan(0);
    expect(metrics.rssMb).toBeGreaterThan(0);
    expect(metrics.cpuUserMs).toBeGreaterThanOrEqual(0);
    expect(metrics.cpuSystemMs).toBeGreaterThanOrEqual(0);
  });

  test("client stores and renders heap, RSS, and CPU status metrics", () => {
    setResourceState({
      state: "degraded",
      detail: "resource pressure",
      heapMb: 42,
      rssMb: 128,
      cpuUserMs: 100,
      cpuSystemMs: 25,
      timestamp: 123,
    });

    const metrics = getResourceMetrics();
    expect(metrics?.heapMb).toBe(42);
    expect(metrics?.rssMb).toBe(128);
    expect(resourceMetricsLabel(metrics)).toBe("heap 42MB · rss 128MB · cpu 125ms");
  });
});
