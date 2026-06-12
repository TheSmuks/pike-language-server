/**
 * resourceNotificationState.ts — Client-side resource-state tracking.
 *
 * Follows the same listener pattern as errorNotificationState.ts.
 * Tracks the server's resource state (active, indexing, degraded, hibernating,
 * hibernated, waking) received via `pike/resourceState` notifications and
 * exposes a callback registration for status-bar updates.
 */

import type { ResourceStateValue, ResourceStateNotification } from "../server/src/features/resourceTypes";

let currentState: ResourceStateValue = "active";
let currentDetail: string | undefined;

type ChangeCallback = (state: ResourceStateValue, detail?: string) => void;
const listeners: ChangeCallback[] = [];

export function setResourceState(state: ResourceStateValue, detail?: string): void {
  currentState = state;
  currentDetail = detail;
  for (const cb of listeners) cb(currentState, currentDetail);
}

export function getResourceState(): ResourceStateValue {
  return currentState;
}

export function getResourceDetail(): string | undefined {
  return currentDetail;
}

/** Register a callback for resource state changes. Returns a dispose function. */
export function onResourceStateChange(cb: ChangeCallback): () => void {
  listeners.push(cb);
  return () => {
    const idx = listeners.indexOf(cb);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

/** Clear all registered listeners (called on extension deactivation). */
export function resetResourceListeners(): void {
  listeners.length = 0;
}

/**
 * Human-readable label for a resource state, for status-bar display.
 */
export function resourceStateLabel(state: ResourceStateValue): string {
  switch (state) {
    case "active": return "";
    case "indexing": return "Indexing";
    case "degraded": return "Degraded";
    case "hibernating": return "Hibernating";
    case "hibernated": return "Hibernated";
    case "waking": return "Waking";
    default: return "";
  }
}
