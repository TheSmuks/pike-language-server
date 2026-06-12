/**
 * PikeWorkerHealthMonitor: heartbeat, health-check, crash-backoff, and
 * idle-eviction tracking for PikeWorkerProcess.
 *
 * Extracted from pikeWorkerProcess.ts to keep the base class under 500 lines.
 * Encapsulates all US3 (ADR 0032) resource-resilience health state.
 */

import type { ChildProcess } from "node:child_process";

// ---------------------------------------------------------------------------
// Crash-backoff constants
// ---------------------------------------------------------------------------

export const CRASH_BACKOFF_THRESHOLD = 3;
export const CRASH_BACKOFF_MS = 30_000;

// ---------------------------------------------------------------------------
// PikeWorkerHealthMonitor
// ---------------------------------------------------------------------------

/**
 * Monitors Pike worker health: heartbeat liveness, health-check failures,
 * and crash-loop backoff. Composed by PikeWorkerProcess.
 */
export class PikeWorkerHealthMonitor {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private healthCheckFailures = 0;

  /**
   * Tracks consecutive Pike process crashes (exit with non-zero, non-127 code).
   * Used to prevent crash loops: if Pike crashes repeatedly, we stop
   * auto-restarting until the backoff period expires.
   */
  private consecutiveCrashes = 0;
  private crashBackoffUntil = 0;

  // -----------------------------------------------------------------------
  // Heartbeat
  // -----------------------------------------------------------------------

  /** Whether the heartbeat interval is currently active. */
  get isHeartbeatActive(): boolean {
    return this.heartbeatTimer !== null;
  }

  /**
   * Start sending heartbeat notifications at the configured interval.
   * The proc getter is called on each tick so the heartbeat always targets
   * the current process (which changes on restart).
   */
  startHeartbeat(
    getProc: () => ChildProcess | null,
    intervalMs: number,
  ): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      const proc = getProc();
      if (!proc || proc.killed) return;
      // Send heartbeat as a fire-and-forget write — no response expected.
      try {
        proc.stdin?.write(JSON.stringify({ method: "heartbeat" }) + "\n");
      } catch {
        // Process may have died between the alive check and the write.
      }
    }, intervalMs);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  /** Stop the heartbeat interval. Safe to call when no heartbeat is active. */
  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // -----------------------------------------------------------------------
  // Health-check tracking
  // -----------------------------------------------------------------------

  /** Number of consecutive health-check failures since the last success. */
  get consecutiveHealthCheckFailures(): number {
    return this.healthCheckFailures;
  }

  /** Record a health-check failure. Increments the consecutive counter. */
  recordHealthCheckFailure(): void {
    this.healthCheckFailures++;
  }

  /** Record a health-check success. Resets the consecutive failure counter. */
  recordHealthCheckSuccess(): void {
    this.healthCheckFailures = 0;
  }

  // -----------------------------------------------------------------------
  // Crash-loop backoff
  // -----------------------------------------------------------------------

  /**
   * Record a crash (non-zero, non-127 exit). Returns true when the
   * backoff threshold is reached — callers should pause auto-restart.
   */
  recordCrash(): boolean {
    this.consecutiveCrashes++;
    if (this.consecutiveCrashes >= CRASH_BACKOFF_THRESHOLD) {
      this.crashBackoffUntil = Date.now() + CRASH_BACKOFF_MS;
      return true;
    }
    return false;
  }

  /** Current consecutive crash count (read by stderr handler for backoff-aware suppression). */
  get consecutiveCrashCount(): number {
    return this.consecutiveCrashes;
  }

  /** Reset the crash counter after a successful response. */
  resetCrashes(): void {
    this.consecutiveCrashes = 0;
  }

  /** Whether the worker is currently in a crash-loop backoff period. */
  get isInBackoff(): boolean {
    return this.consecutiveCrashes >= CRASH_BACKOFF_THRESHOLD &&
      Date.now() < this.crashBackoffUntil;
  }

  /** Remaining backoff time in milliseconds, or 0 if not in backoff. */
  get backoffRemainingMs(): number {
    if (!this.isInBackoff) return 0;
    return Math.max(0, this.crashBackoffUntil - Date.now());
  }

  /** Backoff deadline as epoch milliseconds (0 if never set). */
  get backoffUntilMs(): number {
    return this.crashBackoffUntil;
  }

  /**
   * Check whether the worker may proceed after a crash-loop backoff.
   * If backoff has expired, clears crash state so a fresh start is possible.
   * Returns false while backoff is still active.
   */
  checkAndClearBackoff(): boolean {
    if (this.consecutiveCrashes < CRASH_BACKOFF_THRESHOLD) return true;
    if (Date.now() < this.crashBackoffUntil) return false;
    // Backoff expired — reset so a fresh start is possible.
    this.consecutiveCrashes = 0;
    this.crashBackoffUntil = 0;
    return true;
  }

  // -----------------------------------------------------------------------
  // Static helpers
  // -----------------------------------------------------------------------

  /**
   * Compute exponential backoff delay for worker restart attempts.
   *
   * Formula: base * 2^attempt, capped at maxMs.
   * attempt 0: base, 1: 2*base, 2: 4*base, ... N: min(base * 2^N, maxMs).
   *
   * Static so it can be tested without instantiating a worker.
   */
  static computeBackoffDelayMs(
    attempt: number,
    baseMs: number,
    maxMs: number,
  ): number {
    const raw = baseMs * Math.pow(2, attempt);
    return Math.min(raw, maxMs);
  }
}

// ---------------------------------------------------------------------------
// Idle eviction check
// ---------------------------------------------------------------------------

/**
 * Check whether a worker is idle long enough to be evicted.
 * Returns true if the process is alive and has been idle for at least
 * thresholdMs milliseconds since the last request.
 */
export function isIdleEvictionCandidate(
  proc: ChildProcess | null,
  lastRequestTime: number,
  thresholdMs: number,
): boolean {
  if (!proc || proc.killed) return false;
  if (lastRequestTime === 0) return false;
  return Date.now() - lastRequestTime >= thresholdMs;
}
