/**
 * Core resource-resilience types shared across the server.
 *
 * These types define the vocabulary for indexing modes, memory budgets,
 * resource states, and hibernation. They are consumed by resourceConfiguration,
 * resourceState, serverContext, and feature handlers.
 */

// ---------------------------------------------------------------------------
// Indexing mode
// ---------------------------------------------------------------------------

/**
 * Startup indexing strategy.
 *
 * - `openFiles`: Index only open documents and their bounded dependency closure.
 *   Default. Fast startup, lazy global expansion.
 * - `full`: Index the entire workspace on startup. Slower startup, immediate
 *   global feature availability.
 * - `auto`: Index open files first, then background-scan the rest. Balanced.
 */
export type IndexingMode = "openFiles" | "full" | "auto";

// ---------------------------------------------------------------------------
// Resource state
// ---------------------------------------------------------------------------

/**
 * High-level server resource state reported to the client.
 *
 * The client uses these to update status bar text (non-modal) and to show
 * honest per-request messages when features are temporarily unavailable.
 */
export type ResourceStateValue =
  | "active"
  | "indexing"
  | "degraded"
  | "hibernating"
  | "hibernated"
  | "waking";

/**
 * Payload sent via the `pike/resourceState` notification.
 */
export interface ResourceStateNotification {
  state: ResourceStateValue;
  /** Human-readable detail (e.g. "reindexing after dependency change"). */
  detail?: string;
  /** Approximate heap usage in MB, when known. */
  heapMb?: number;
  /** Number of indexed entries, when relevant. */
  entryCount?: number;
  /** Epoch milliseconds when the notification was emitted. */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Memory budget
// ---------------------------------------------------------------------------

/**
 * Memory budget configuration for degraded-mode decisions.
 */
export interface MemoryBudget {
  /** Max heap in MB before degraded mode triggers. */
  budgetMb: number;
  /** When heap exceeds this fraction of budgetMb, demotion begins. */
  demotionThresholdFraction: number;
  /** When heap drops below this fraction, demotion stops (hysteresis). */
  recoveryThresholdFraction: number;
}

// ---------------------------------------------------------------------------
// Hibernation state
// ---------------------------------------------------------------------------

/**
 * Hibernation lifecycle state.
 */
export type HibernationStateValue = "awake" | "idle" | "hibernating" | "hibernated" | "waking";

// ---------------------------------------------------------------------------
// Resource configuration (top-level)
// ---------------------------------------------------------------------------

/**
 * Complete resource-resilience configuration.
 *
 * Parsed from initialization options and workspace/didChangeConfiguration settings.
 * See contracts/configuration.md for the schema.
 */
export interface ResourceConfiguration {
  indexing: {
    mode: IndexingMode;
    ignoreGlobs: string[];
    maxFileSizeBytes: number;
    /** Max dependency closure depth when mode is openFiles. */
    dependencyClosureDepth: number;
    /** Max dependency closure total entries when mode is openFiles. */
    dependencyClosureCount: number;
    /** Max discovered file count for `auto` mode to upgrade to `full`. */
    fullScanFileLimit: number;
  };
  memory: MemoryBudget;
  worker: {
    requestTimeoutMs: number;
    heartbeatIntervalMs: number;
    watchdogTimeoutMs: number;
    idleEvictionMs: number;
    healthCheckIntervalMs: number;
    maxConsecutiveFailures: number;
    backoffInitialMs: number;
    backoffMaxMs: number;
  };
  hibernation: {
    idleThresholdMs: number;
    /** Sustained activity duration before full/auto reindex resumes. */
    sustainedActivityMs: number;
  };
}
