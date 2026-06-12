/**
 * Resource-resilience configuration: defaults, parsing, and validation.
 *
 * Parses from LSP initialization options and workspace/didChangeConfiguration
 * settings. See contracts/configuration.md for the full schema.
 *
 * All values have explicit defaults — a missing key never produces undefined
 * downstream. Validation clamps out-of-range values to safe bounds rather
 * than throwing, so a malformed setting degrades rather than crashes.
 */

import type { ResourceConfiguration, IndexingMode } from "./resourceTypes";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_RESOURCE_CONFIG: ResourceConfiguration = {
  indexing: {
    mode: "openFiles",
    ignoreGlobs: [],
    maxFileSizeBytes: 1_048_576, // 1 MB
    dependencyClosureDepth: 5,
    dependencyClosureCount: 200,
    fullScanFileLimit: 500,
  },
  memory: {
    budgetMb: 512,
    demotionThresholdFraction: 0.80,
    recoveryThresholdFraction: 0.60,
  },
  worker: {
    requestTimeoutMs: 5_000,
    heartbeatIntervalMs: 10_000,
    watchdogTimeoutMs: 60_000,
    idleEvictionMs: 300_000, // 5 minutes
    healthCheckIntervalMs: 15_000,
    maxConsecutiveFailures: 3,
    backoffInitialMs: 1_000,
    backoffMaxMs: 30_000,
  },
  hibernation: {
    idleThresholdMs: 600_000, // 10 minutes
    sustainedActivityMs: 30_000, // 30s of activity before full reindex resumes
  },
};

// ---------------------------------------------------------------------------
// Clamping bounds
// ---------------------------------------------------------------------------

const BOUNDS = {
  maxFileSizeBytes: { min: 1024, max: 50 * 1024 * 1024 },
  dependencyClosureDepth: { min: 0, max: 20 },
  dependencyClosureCount: { min: 0, max: 10_000 },
  fullScanFileLimit: { min: 0, max: 50_000 },
  budgetMb: { min: 64, max: 8192 },
  demotionThresholdFraction: { min: 0.5, max: 0.99 },
  recoveryThresholdFraction: { min: 0.1, max: 0.8 },
  requestTimeoutMs: { min: 1_000, max: 60_000 },
  heartbeatIntervalMs: { min: 1_000, max: 120_000 },
  watchdogTimeoutMs: { min: 5_000, max: 600_000 },
  idleEvictionMs: { min: 0, max: 3_600_000 },
  healthCheckIntervalMs: { min: 1_000, max: 300_000 },
  maxConsecutiveFailures: { min: 1, max: 20 },
  backoffInitialMs: { min: 100, max: 30_000 },
  backoffMaxMs: { min: 1_000, max: 300_000 },
  idleThresholdMs: { min: 10_000, max: 86_400_000 },
  sustainedActivityMs: { min: 0, max: 600_000 },
} as const;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Clamp a numeric value to a safe range.
 *
 * Non-finite values (strings, NaN, Infinity, undefined) return `fallback`
 * rather than the minimum — this preserves user intent when a setting is
 * explicitly malformed (we fall back to default, not to the floor).
 */
function clamp(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function isIndexingMode(value: unknown): value is IndexingMode {
  return value === "openFiles" || value === "full" || value === "auto";
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Raw shape of resource configuration as received from initialization options
 * or workspace settings. All fields optional — missing fields use defaults.
 */
export interface RawResourceSettings {
  indexingMode?: string;
  indexIgnoreGlobs?: string[];
  indexMaxFileSizeBytes?: number;
  indexDependencyClosureDepth?: number;
  indexDependencyClosureCount?: number;
  indexFullScanFileLimit?: number;
  memoryBudgetMb?: number;
  workerRequestTimeoutMs?: number;
  workerHeartbeatIntervalMs?: number;
  workerWatchdogTimeoutMs?: number;
  workerIdleEvictionMs?: number;
  workerHealthCheckIntervalMs?: number;
  workerMaxConsecutiveFailures?: number;
  workerBackoffInitialMs?: number;
  workerBackoffMaxMs?: number;
  hibernationIdleThresholdMs?: number;
  hibernationSustainedActivityMs?: number;
}

/**
 * Parse and validate resource-resilience configuration from raw settings.
 *
 * Missing or invalid values fall back to defaults. Out-of-range values are
 * clamped to safe bounds. This never throws — a bad setting degrades, it
 * does not crash the server.
 */
export function parseResourceConfig(raw: RawResourceSettings | undefined | null): ResourceConfiguration {
  const r = raw ?? {};
  const mode = isIndexingMode(r.indexingMode) ? r.indexingMode : DEFAULT_RESOURCE_CONFIG.indexing.mode;
  const ignoreGlobs = Array.isArray(r.indexIgnoreGlobs)
    ? r.indexIgnoreGlobs.filter((g): g is string => typeof g === "string")
    : DEFAULT_RESOURCE_CONFIG.indexing.ignoreGlobs;

  const d = DEFAULT_RESOURCE_CONFIG;
  const db = d.memory.demotionThresholdFraction;
  const rb = d.memory.recoveryThresholdFraction;

  let demotionFraction = clamp(db, db, BOUNDS.demotionThresholdFraction.min, BOUNDS.demotionThresholdFraction.max);
  let recoveryFraction = clamp(rb, rb, BOUNDS.recoveryThresholdFraction.min, BOUNDS.recoveryThresholdFraction.max);

  // Ensure recovery < demotion (hysteresis).
  if (recoveryFraction >= demotionFraction) {
    recoveryFraction = demotionFraction * 0.75;
  }

  return {
    indexing: {
      mode,
      ignoreGlobs,
      maxFileSizeBytes: clamp(r.indexMaxFileSizeBytes, d.indexing.maxFileSizeBytes, BOUNDS.maxFileSizeBytes.min, BOUNDS.maxFileSizeBytes.max),
      dependencyClosureDepth: clamp(r.indexDependencyClosureDepth, d.indexing.dependencyClosureDepth, BOUNDS.dependencyClosureDepth.min, BOUNDS.dependencyClosureDepth.max),
      dependencyClosureCount: clamp(r.indexDependencyClosureCount, d.indexing.dependencyClosureCount, BOUNDS.dependencyClosureCount.min, BOUNDS.dependencyClosureCount.max),
      fullScanFileLimit: clamp(r.indexFullScanFileLimit, d.indexing.fullScanFileLimit, BOUNDS.fullScanFileLimit.min, BOUNDS.fullScanFileLimit.max),
    },
    memory: {
      budgetMb: clamp(r.memoryBudgetMb, d.memory.budgetMb, BOUNDS.budgetMb.min, BOUNDS.budgetMb.max),
      demotionThresholdFraction: demotionFraction,
      recoveryThresholdFraction: recoveryFraction,
    },
    worker: {
      requestTimeoutMs: clamp(r.workerRequestTimeoutMs, d.worker.requestTimeoutMs, BOUNDS.requestTimeoutMs.min, BOUNDS.requestTimeoutMs.max),
      heartbeatIntervalMs: clamp(r.workerHeartbeatIntervalMs, d.worker.heartbeatIntervalMs, BOUNDS.heartbeatIntervalMs.min, BOUNDS.heartbeatIntervalMs.max),
      watchdogTimeoutMs: clamp(r.workerWatchdogTimeoutMs, d.worker.watchdogTimeoutMs, BOUNDS.watchdogTimeoutMs.min, BOUNDS.watchdogTimeoutMs.max),
      idleEvictionMs: clamp(r.workerIdleEvictionMs, d.worker.idleEvictionMs, BOUNDS.idleEvictionMs.min, BOUNDS.idleEvictionMs.max),
      healthCheckIntervalMs: clamp(r.workerHealthCheckIntervalMs, d.worker.healthCheckIntervalMs, BOUNDS.healthCheckIntervalMs.min, BOUNDS.healthCheckIntervalMs.max),
      maxConsecutiveFailures: clamp(r.workerMaxConsecutiveFailures, d.worker.maxConsecutiveFailures, BOUNDS.maxConsecutiveFailures.min, BOUNDS.maxConsecutiveFailures.max),
      backoffInitialMs: clamp(r.workerBackoffInitialMs, d.worker.backoffInitialMs, BOUNDS.backoffInitialMs.min, BOUNDS.backoffInitialMs.max),
      backoffMaxMs: clamp(r.workerBackoffMaxMs, d.worker.backoffMaxMs, BOUNDS.backoffMaxMs.min, BOUNDS.backoffMaxMs.max),
    },
    hibernation: {
      idleThresholdMs: clamp(r.hibernationIdleThresholdMs, d.hibernation.idleThresholdMs, BOUNDS.idleThresholdMs.min, BOUNDS.idleThresholdMs.max),
      sustainedActivityMs: clamp(r.hibernationSustainedActivityMs, d.hibernation.sustainedActivityMs, BOUNDS.sustainedActivityMs.min, BOUNDS.sustainedActivityMs.max),
    },
  };
}

// ---------------------------------------------------------------------------
// Auto-mode resolution (T050, US2)
// ---------------------------------------------------------------------------

/**
 * Resolve an indexing mode after discovering how many files the workspace has.
 *
 * - `full` and `openFiles` pass through unchanged.
 * - `auto` upgrades to `full` when the discovery count is at or below
 *   `fullScanFileLimit`; otherwise it falls back to `openFiles` and the caller
 *   should log the demotion reason.
 *
 * This never throws. Callers are expected to log the resolved mode when it
 * differs from the configured mode.
 */
export function resolveAutoMode(
  mode: IndexingMode,
  discoveredFileCount: number,
  fullScanFileLimit: number,
): IndexingMode {
  if (mode !== "auto") return mode;
  // auto behaves like full only when discovery count is at or below the limit.
  return discoveredFileCount <= fullScanFileLimit ? "full" : "openFiles";
}
