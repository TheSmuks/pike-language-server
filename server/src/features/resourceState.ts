/**
 * Resource-state tracking and notification sender.
 *
 * Tracks the server's high-level resource state (active, indexing, degraded,
 * hibernating, hibernated, waking) and emits `pike/resourceState` notifications
 * to the client on transitions.
 *
 * Also manages cancellation sources for background work that must be cancelled
 * on hibernation or shutdown.
 *
 * Activity and open-document tracking live on HibernationManager, which owns
 * the idle/hibernate decision and is wired to the request and document paths.
 * This tracker deliberately keeps no copy of them: a second, unwired counter
 * would read zero forever and silently mislead anyone who consulted it.
 */

import type { Connection } from "vscode-languageserver/node";
import type { CancellationTokenSource } from "vscode-languageserver/node";
import type {
  ResourceStateValue,
  ResourceStateNotification,
  ResourceProcessMetrics,
  MemoryBudget,
} from "./resourceTypes";

// ---------------------------------------------------------------------------
// State tracker
// ---------------------------------------------------------------------------

export class ResourceStateTracker {
  private currentState: ResourceStateValue = "active";
  private readonly cts: CancellationTokenSource;
  private readonly send: (notification: ResourceStateNotification) => void;

  constructor(
    sendFn: (notification: ResourceStateNotification) => void,
    cts: CancellationTokenSource,
  ) {
    this.send = sendFn;
    this.cts = cts;
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
    const metrics = sampleResourceMetrics();
    this.send({
      state: newState,
      detail: detail ?? `transitioned from ${oldState} to ${newState}`,
      ...metrics,
      timestamp: nowMs(),
    });
    return true;
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
// Process resource metrics
// ---------------------------------------------------------------------------

export function sampleResourceMetrics(): ResourceProcessMetrics {
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  return {
    heapMb: bytesToMegabytes(memory.heapUsed),
    rssMb: bytesToMegabytes(memory.rss),
    cpuUserMs: microsecondsToMilliseconds(cpu.user),
    cpuSystemMs: microsecondsToMilliseconds(cpu.system),
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
  private readonly onSustainedPressure: (() => void) | undefined;
  private readonly heapSource: HeapSource;

  constructor(
    budget: MemoryBudget,
    onPressure: () => void,
    onRecovery: () => void,
    heapSource?: HeapSource,
    onSustainedPressure?: () => void,
  ) {
    this.budget = budget;
    this.onPressure = onPressure;
    this.onRecovery = onRecovery;
    this.onSustainedPressure = onSustainedPressure;
    this.heapSource = heapSource ?? {
      getHeapUsedMb: () => process.memoryUsage().rss / (1024 * 1024),
    };
  }

  /**
   * Check current heap usage and fire transitions if thresholds are crossed.
   * Safe to call on a timer or after significant events.
   *
   * `onPressure`/`onRecovery` are edge-triggered — they fire once per degraded
   * episode and drive the client-facing state notification. `onSustainedPressure`
   * is level-triggered: it fires on *every* check while usage stays above the
   * demotion threshold. Relief work (dropping non-open symbol tables) must run
   * here, not on the edge — otherwise the very first demotion latches `degraded`
   * and, because RSS seldom falls back below the recovery threshold after a GC,
   * the governor would go silent while newly-opened files keep growing the heap
   * unbounded toward the hard cap.
   */
  check(): void {
    const usedMb = this.heapSource.getHeapUsedMb();
    const demotionThresholdMb = this.budget.budgetMb * this.budget.demotionThresholdFraction;
    const recoveryThresholdMb = this.budget.budgetMb * this.budget.recoveryThresholdFraction;

    if (usedMb > demotionThresholdMb) {
      if (!this.degraded) {
        this.degraded = true;
        this.onPressure();
      }
      this.onSustainedPressure?.();
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

function bytesToMegabytes(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

function microsecondsToMilliseconds(microseconds: number): number {
  return Math.round(microseconds / 1000);
}
