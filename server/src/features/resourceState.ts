/**
 * Resource-state tracking and notification sender.
 *
 * Tracks the server's high-level resource state (active, indexing, degraded,
 * hibernating, hibernated, waking) and emits `pike/resourceState` notifications
 * to the client on transitions.
 *
 * Also tracks request activity and open-document count for hibernation idle
 * decisions, and manages cancellation sources for background work that must
 * be cancelled on hibernation or shutdown.
 */

import type { Connection } from "vscode-languageserver/node";
import type { CancellationTokenSource } from "vscode-languageserver/node";
import type {
  ResourceStateValue,
  ResourceStateNotification,
  MemoryBudget,
} from "./resourceTypes";

// ---------------------------------------------------------------------------
// State tracker
// ---------------------------------------------------------------------------

export class ResourceStateTracker {
  private currentState: ResourceStateValue = "active";
  private lastActivityMs: number;
  private openDocumentCount = 0;
  private readonly cts: CancellationTokenSource;
  private readonly send: (notification: ResourceStateNotification) => void;

  constructor(
    sendFn: (notification: ResourceStateNotification) => void,
    cts: CancellationTokenSource,
  ) {
    this.send = sendFn;
    this.cts = cts;
    this.lastActivityMs = nowMs();
  }

  // --- State transitions ---

  getState(): ResourceStateValue {
    return this.currentState;
  }

  /**
   * Transition to a new state. Sends a notification only on actual change.
   * Returns true if the state changed, false if it was already the target.
   */
  transition(newState: ResourceStateValue, detail?: string): boolean {
    if (this.currentState === newState) return false;
    const oldState = this.currentState;
    this.currentState = newState;
    this.send({
      state: newState,
      detail: detail ?? `transitioned from ${oldState} to ${newState}`,
      timestamp: nowMs(),
    });
    return true;
  }

  // --- Activity tracking ---

  /** Record that a request or user interaction occurred. */
  recordActivity(): void {
    this.lastActivityMs = nowMs();
  }

  /** Get the timestamp of the last activity. */
  getLastActivityMs(): number {
    return this.lastActivityMs;
  }

  /** Milliseconds since last activity. */
  idleMs(): number {
    return nowMs() - this.lastActivityMs;
  }

  // --- Open document tracking ---

  onDocumentOpen(): void {
    this.openDocumentCount++;
    this.recordActivity();
  }

  onDocumentClose(): void {
    if (this.openDocumentCount > 0) this.openDocumentCount--;
  }

  getOpenDocumentCount(): number {
    return this.openDocumentCount;
  }

  // --- Cancellation ---

  /**
   * Get the cancellation token for background work.
   * Cancelled on hibernation or shutdown.
   */
  getCancellationToken(): CancellationTokenSource {
    return this.cts;
  }

  /**
   * Cancel all background work. Called on hibernation and shutdown.
   * Creates a fresh CTS so new work after wake can proceed.
   */
  cancelBackgroundWork(): CancellationTokenSource {
    this.cts.cancel();
    return this.cts;
  }
}

// ---------------------------------------------------------------------------
// Notification sender
// ---------------------------------------------------------------------------

/**
 * Create a function that sends pike/resourceState notifications on a connection.
 */
export function createResourceStateSender(connection: Connection): (n: ResourceStateNotification) => void {
  return (notification: ResourceStateNotification) => {
    try {
      connection.sendNotification("pike/resourceState", notification);
    } catch {
      // Connection may be closed during teardown — swallow.
    }
  };
}

// ---------------------------------------------------------------------------
// Heap-pressure monitor with hysteresis (US3)
// ---------------------------------------------------------------------------

/**
 * Injectable heap-usage source. Defaults to process.memoryUsage().rss.
 * Tests inject a controllable source to simulate pressure scenarios.
 */
export interface HeapSource {
  getHeapUsedMb(): number;
}

/**
 * Heap-pressure monitor with hysteresis.
 *
 * Tracks heap usage relative to a memory budget. When heap exceeds the
 * demotion threshold fraction of the budget, fires onPressure once and
 * enters degraded state. When heap drops below the recovery threshold
 * fraction, fires onRecovery once and exits degraded state.
 *
 * Hysteresis (recoveryThreshold < demotionThreshold) prevents oscillation
 * at the threshold boundary. Each callback fires exactly once per transition.
 */
export class HeapPressureMonitor {
  private degraded = false;
  private readonly budget: MemoryBudget;
  private readonly onPressure: () => void;
  private readonly onRecovery: () => void;
  private readonly heapSource: HeapSource;

  constructor(
    budget: MemoryBudget,
    onPressure: () => void,
    onRecovery: () => void,
    heapSource?: HeapSource,
  ) {
    this.budget = budget;
    this.onPressure = onPressure;
    this.onRecovery = onRecovery;
    this.heapSource = heapSource ?? {
      getHeapUsedMb: () => process.memoryUsage().rss / (1024 * 1024),
    };
  }

  /**
   * Check current heap usage and fire transitions if thresholds are crossed.
   * Safe to call on a timer or after significant events.
   */
  check(): void {
    const usedMb = this.heapSource.getHeapUsedMb();
    const demotionThresholdMb = this.budget.budgetMb * this.budget.demotionThresholdFraction;
    const recoveryThresholdMb = this.budget.budgetMb * this.budget.recoveryThresholdFraction;

    if (!this.degraded && usedMb > demotionThresholdMb) {
      this.degraded = true;
      this.onPressure();
    } else if (this.degraded && usedMb < recoveryThresholdMb) {
      this.degraded = false;
      this.onRecovery();
    }
  }

  /** True if the server is currently in degraded mode (above demotion threshold). */
  isDegraded(): boolean {
    return this.degraded;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowMs(): number {
  const fake = process.env.PIKE_LSP_FAKE_CLOCK_MS;
  if (fake !== undefined) {
    const parsed = parseInt(fake, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}
