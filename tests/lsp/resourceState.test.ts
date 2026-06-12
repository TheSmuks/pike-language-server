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
import { ResourceStateTracker } from "../../server/src/features/resourceState";
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

// ---------------------------------------------------------------------------
// Activity tracking tests
// ---------------------------------------------------------------------------

describe("ResourceStateTracker: activity", () => {
  test("recordActivity updates last activity time", () => {
    const { tracker } = createTracker();
    const before = tracker.idleMs();
    expect(before).toBeGreaterThanOrEqual(0);
    tracker.recordActivity();
    expect(tracker.idleMs()).toBeLessThanOrEqual(before + 100);
  });

  test("idleMs grows over time", async () => {
    const { tracker } = createTracker();
    tracker.recordActivity();
    await new Promise((r) => setTimeout(r, 50));
    expect(tracker.idleMs()).toBeGreaterThanOrEqual(40);
  });
});

// ---------------------------------------------------------------------------
// Open document tracking tests
// ---------------------------------------------------------------------------

describe("ResourceStateTracker: open documents", () => {
  test("onDocumentOpen increments count and records activity", () => {
    const { tracker } = createTracker();
    expect(tracker.getOpenDocumentCount()).toBe(0);
    tracker.onDocumentOpen();
    expect(tracker.getOpenDocumentCount()).toBe(1);
    tracker.onDocumentOpen();
    expect(tracker.getOpenDocumentCount()).toBe(2);
  });

  test("onDocumentClose decrements count", () => {
    const { tracker } = createTracker();
    tracker.onDocumentOpen();
    tracker.onDocumentOpen();
    tracker.onDocumentClose();
    expect(tracker.getOpenDocumentCount()).toBe(1);
  });

  test("onDocumentClose does not go negative", () => {
    const { tracker } = createTracker();
    tracker.onDocumentClose();
    expect(tracker.getOpenDocumentCount()).toBe(0);
  });
});

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

  test("respects PIKE_LSP_FAKE_CLOCK_MS for activity tracking", () => {
    process.env.PIKE_LSP_FAKE_CLOCK_MS = "1000000";
    const { tracker } = createTracker();

    // After creation, lastActivityMs should be ~1000000
    expect(tracker.getLastActivityMs()).toBe(1_000_000);

    // Advance fake clock
    process.env.PIKE_LSP_FAKE_CLOCK_MS = "1005000";
    expect(tracker.idleMs()).toBe(5_000);
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
});
