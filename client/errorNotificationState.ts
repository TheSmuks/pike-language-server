/**
 * errorNotificationState.ts — Client-side error count tracking.
 *
 * Tracks error counts received from the server via ` Pike/errorCount`
 * notifications and exposes a way to register a callback when the count
 * changes (for status bar updates).
 */

let errorCount = 0;

type ChangeCallback = (count: number) => void;
const listeners: ChangeCallback[] = [];

export function setErrorCount(n: number): void {
  errorCount = n;
  for (const cb of listeners) cb(errorCount);
}

export function getErrorCount(): number {
  return errorCount;
}

/** Register a callback for error count changes. */
export function onErrorCountChange(cb: ChangeCallback): void {
  listeners.push(cb);
}