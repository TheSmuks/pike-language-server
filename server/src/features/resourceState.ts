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
