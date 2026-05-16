/**
 * Pike worker lifecycle helpers — idle eviction and memory ceiling checks.
 *
 * Pure functions extracted from PikeWorkerProcess so the base class stays
 * under 500 lines. All state is passed in; nothing is captured.
 */

import type { ChildProcess } from "node:child_process";

// ---------------------------------------------------------------------------
// Idle eviction
// ---------------------------------------------------------------------------

/**
 * Decide whether an idle worker should be evicted.
 * Returns true when the process is alive and all queues are empty.
 */
export function shouldEvictIdle(
  proc: ChildProcess | null,
  pendingSize: number,
  queueLengths: number[],
): boolean {
  return !!(
    proc &&
    !proc.killed &&
    pendingSize === 0 &&
    queueLengths.every((l) => l === 0)
  );
}

// ---------------------------------------------------------------------------
// Memory / request ceiling
// ---------------------------------------------------------------------------

/**
 * Decide whether the worker should be force-restarted due to request-count
 * or active-time ceilings.
 */
export function shouldForceRestart(
  proc: ChildProcess | null,
  requestCount: number,
  maxRequests: number,
  startTime: number,
  maxActiveMinutes: number,
): boolean {
  if (!proc || proc.killed) return false;

  if (requestCount >= maxRequests) return true;

  if (startTime > 0) {
    const activeMinutes = (Date.now() - startTime) / 60_000;
    if (activeMinutes >= maxActiveMinutes) return true;
  }

  return false;
}
