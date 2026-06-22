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
let currentMetrics: ResourceStateMetrics | undefined;

type ResourceStateMetrics = Pick<
  ResourceStateNotification,
  "heapMb" | "rssMb" | "cpuUserMs" | "cpuSystemMs"
>;

type ChangeCallback = (state: ResourceStateValue, detail?: string, metrics?: ResourceStateMetrics) => void;
const listeners: ChangeCallback[] = [];

export function setResourceState(notification: ResourceStateNotification): void;
export function setResourceState(state: ResourceStateValue, detail?: string): void;
export function setResourceState(
  stateOrNotification: ResourceStateValue | ResourceStateNotification,
  detail?: string,
): void {
  if (typeof stateOrNotification === "string") {
    currentState = stateOrNotification;
    currentDetail = detail;
    currentMetrics = undefined;
  } else {
    currentState = stateOrNotification.state;
    currentDetail = stateOrNotification.detail;
    currentMetrics = {
      heapMb: stateOrNotification.heapMb,
      rssMb: stateOrNotification.rssMb,
      cpuUserMs: stateOrNotification.cpuUserMs,
      cpuSystemMs: stateOrNotification.cpuSystemMs,
    };
  }
  for (const cb of listeners) cb(currentState, currentDetail, currentMetrics);
}

export function getResourceState(): ResourceStateValue {
  return currentState;
}

export function getResourceDetail(): string | undefined {
  return currentDetail;
}

export function getResourceMetrics(): ResourceStateMetrics | undefined {
  return currentMetrics;
}

export function resourceMetricsLabel(metrics: ResourceStateMetrics | undefined): string {
  if (!metrics) return "";
  const parts: string[] = [];
  if (metrics.heapMb !== undefined) parts.push(`heap ${metrics.heapMb}MB`);
  if (metrics.rssMb !== undefined) parts.push(`rss ${metrics.rssMb}MB`);
  const cpuMs = (metrics.cpuUserMs ?? 0) + (metrics.cpuSystemMs ?? 0);
  if (cpuMs > 0) parts.push(`cpu ${cpuMs}ms`);
  return parts.join(" · ");
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
