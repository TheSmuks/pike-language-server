/**
 * Lightweight profiling instrumentation for the indexing pipeline.
 *
 * Activated by setting the environment variable PIKE_LSP_PROFILE=1 at startup.
 * When active, accumulates wall-clock timing spans and counters for every major
 * sub-phase of the indexing pipeline. When inactive, every public function is a
 * no-op that the JIT will inline away — zero production overhead.
 *
 * Usage:
 *   PIKE_LSP_PROFILE=1 code-insiders .
 *
 * The report is printed to the LSP output channel on shutdown (step 8) and can
 * also be requested mid-session via a notification (future work).
 *
 * Design: hierarchical spans with start/stop, plus named counters. Spans are
 * stored in a flat array — no nesting objects — so accumulation is allocation-
 * free after the initial array growth.
 */

// ---------------------------------------------------------------------------
// Activation gate
// ---------------------------------------------------------------------------

const ENABLED = process.env.PIKE_LSP_PROFILE === "1";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TimingSpan {
  /** Human-readable name matching the indexing sub-phase. */
  name: string;
  /** Wall-clock time in milliseconds. */
  durationMs: number;
}

export interface ProfilerCounters {
  /** Number of files discovered by the recursive directory walk. */
  filesDiscovered: number;
  /** Number of files read from disk (readFile calls). */
  fileReads: number;
  /** Number of tree-sitter parse() calls. */
  parseCalls: number;
  /** Number of symbol tables built (buildSymbolTable). */
  symbolTablesBuilt: number;
  /** Number of index batch writes (upsertFile / upsertBackgroundFile / upsertCachedFile). */
  indexWrites: number;
  /** Number of index writes via the full resolution path (upsertFile). */
  indexWritesFull: number;
  /** Number of index writes via the background path (upsertBackgroundFile). */
  indexWritesBackground: number;
  /** Number of index writes via the cache restore path (upsertCachedFile). */
  indexWritesCached: number;
  /** Number of persistent cache disk writes. */
  cacheDiskWrites: number;
  /** Number of persistent cache disk reads. */
  cacheDiskReads: number;
  /** Number of dependency resolution calls (warmResolverCache). */
  depResolutionCalls: number;
  /** Number of lazy dependency resolution calls (ensureDependenciesResolved). */
  lazyDepResolutionCalls: number;
  /** Number of tree cache evictions. */
  treeEvictions: number;
  /** Number of inheritance wiring operations (wireInheritance). */
  inheritanceWiringOps: number;
}

interface PendingSpan {
  name: string;
  start: number;
}

// ---------------------------------------------------------------------------
// State (only allocated when enabled)
// ---------------------------------------------------------------------------

let spans: TimingSpan[] = [];
let pending: PendingSpan[] = [];
let counters: ProfilerCounters = freshCounters();

const startTime = ENABLED ? performance.now() : 0;

function freshCounters(): ProfilerCounters {
  return {
    filesDiscovered: 0,
    fileReads: 0,
    parseCalls: 0,
    symbolTablesBuilt: 0,
    indexWrites: 0,
    indexWritesFull: 0,
    indexWritesBackground: 0,
    indexWritesCached: 0,
    cacheDiskWrites: 0,
    cacheDiskReads: 0,
    depResolutionCalls: 0,
    lazyDepResolutionCalls: 0,
    treeEvictions: 0,
    inheritanceWiringOps: 0,
  };
}

// ---------------------------------------------------------------------------
// Public API — no-ops when disabled
// ---------------------------------------------------------------------------

/** Returns true when profiling is active. */
export function isProfiling(): boolean {
  return ENABLED;
}

/**
 * Start a named timing span. Call stopSpan() with the same name to complete.
 * Nested spans are supported — the profiler tracks a stack of pending spans.
 */
export function startSpan(_name: string): void {
  if (!ENABLED) return;
  pending.push({ name: _name, start: performance.now() });
}

/**
 * Stop the most recently started span matching `name`.
 * Records the elapsed wall-clock time.
 */
export function stopSpan(_name: string): void {
  if (!ENABLED) return;
  // Find the last pending span with this name (supports nesting).
  for (let i = pending.length - 1; i >= 0; i--) {
    if (pending[i].name === _name) {
      const entry = pending.splice(i, 1)[0];
      spans.push({
        name: _name,
        durationMs: performance.now() - entry.start,
      });
      return;
    }
  }
  // Unmatched stopSpan — log in debug builds only.
}

/**
 * Measure a synchronous function as a named span.
 */
export function measureSync<T>(_name: string, fn: () => T): T {
  if (!ENABLED) return fn();
  startSpan(_name);
  try {
    return fn();
  } finally {
    stopSpan(_name);
  }
}

/**
 * Measure an async function as a named span.
 */
export async function measureAsync<T>(_name: string, fn: () => Promise<T>): Promise<T> {
  if (!ENABLED) return fn();
  startSpan(_name);
  try {
    return await fn();
  } finally {
    stopSpan(_name);
  }
}

/** Increment a named counter by `delta` (default 1). */
export function bump(_counter: keyof ProfilerCounters, _delta?: number): void {
  if (!ENABLED) return;
  counters[_counter] += (_delta ?? 1);
}

/** Aggregate matched spans into byName map. */
function aggregateSpans(matched: TimingSpan[]): Map<string, { count: number; totalMs: number; maxMs: number; minMs: number }> {
  const byName = new Map<string, { count: number; totalMs: number; maxMs: number; minMs: number }>();
  for (const span of matched) {
    const existing = byName.get(span.name);
    if (existing) {
      existing.count++;
      existing.totalMs += span.durationMs;
      existing.maxMs = Math.max(existing.maxMs, span.durationMs);
      existing.minMs = Math.min(existing.minMs, span.durationMs);
    } else {
      byName.set(span.name, { count: 1, totalMs: span.durationMs, maxMs: span.durationMs, minMs: span.durationMs });
    }
  }
  return byName;
}

/** Emit category lines for a group of matched spans. */
function emitCategoryLines(lines: string[], matched: TimingSpan[]): void {
  const byName = aggregateSpans(matched);
  const sorted = [...byName.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs);
  for (const [name, stats] of sorted) {
    const avg = stats.totalMs / stats.count;
    lines.push(
      stats.count === 1
        ? `  ${name}: ${fmtMs(stats.totalMs)}`
        : `  ${name}: ${fmtMs(stats.totalMs)} (${stats.count}x, avg ${fmtMs(avg)}, min ${fmtMs(stats.minMs)}, max ${fmtMs(stats.maxMs)})`,
    );
  }
}

/** Build the SUMMARY section of the report. */
function buildReportSummary(lines: string[], parseTime: number, buildTime: number, totalMs: number, indexWrites: number): void {
  lines.push("── SUMMARY ──");
  lines.push(`  Files indexed:    ${indexWrites}`);
  if (indexWrites > 0) {
    lines.push(`  Avg parse time:   ${fmtMs(parseTime / Math.max(counters.parseCalls, 1))}/file`);
    lines.push(`  Avg build time:   ${fmtMs(buildTime / Math.max(counters.symbolTablesBuilt, 1))}/file`);
  }
  lines.push(`  Throughput:       ${indexWrites > 0 ? fmtMs(totalMs / indexWrites) : "N/A"}/file`);
}

function emitReportHeader(lines: string[], totalMs: number): void {
  lines.push("════════════════════════════════════════════════════════");
  lines.push("  PIKE LSP PROFILING REPORT");
  lines.push(`  Total wall-clock: ${fmtMs(totalMs)}`);
  lines.push("════════════════════════════════════════════════════════");
  lines.push("");
}

/**
 * Generate the profiling report as a human-readable string.
 * Breaks down wall-clock time by sub-phase, grouped into the two main
 * phases (symbol table building and index upsert). Counters are printed at the end.
 */
export function generateReport(): string {
  if (!ENABLED) return "[profiler] not active — set PIKE_LSP_PROFILE=1";

  const totalMs = performance.now() - startTime;
  const lines: string[] = [];
  emitReportHeader(lines, totalMs);

  const categories: Record<string, string[]> = {
    "FILE DISCOVERY": ["discoverFiles"],
    "FILE I/O": ["readFile", "cacheRead", "cacheWrite", "cacheWasmHash"],
    "PARSING": ["parse", "parserInit"],
    "SYMBOL TABLE BUILD": ["buildSymbolTable", "declarationPass", "referencePass", "wireInheritance", "buildTable", "propagateAssignedTypes"],
    "INDEX UPSERT": ["upsertFile", "upsertBackgroundFile", "upsertCachedFile", "warmResolverCache", "extractDependencies", "ensureDependenciesResolved"],
    "BACKGROUND INDEXING": ["backgroundIndex", "batchParse", "batchUpsert"],
    "CACHE PERSISTENCE": ["saveCache", "loadCache", "serializeCache", "deserializeCache"],
  };

  for (const [category, spanNames] of Object.entries(categories)) {
    const matched = spans.filter(s => spanNames.includes(s.name));
    if (matched.length === 0) continue;
    const total = matched.reduce((sum, s) => sum + s.durationMs, 0);
    lines.push(`── ${category} (${fmtMs(total)}) ──`);
    emitCategoryLines(lines, matched);
    lines.push("");
  }

  const allCategorized = new Set(Object.values(categories).flat());
  const uncategorized = spans.filter(s => !allCategorized.has(s.name));
  if (uncategorized.length > 0) {
    lines.push("── OTHER ──");
    for (const span of uncategorized) lines.push(`  ${span.name}: ${fmtMs(span.durationMs)}`);
    lines.push("");
  }

  lines.push("── COUNTERS ──");
  const counterEntries = Object.entries(counters) as [keyof ProfilerCounters, number][];
  const maxKeyLen = Math.max(...counterEntries.map(([k]) => k.length));
  counterEntries.forEach(([key, value]) => { if (value > 0) lines.push(`  ${key.padEnd(maxKeyLen)}  ${value}`); });
  lines.push("");

  const indexWrites = counters.indexWrites;
  buildReportSummary(lines,
    spans.filter(s => s.name === "parse").reduce((sum, s) => sum + s.durationMs, 0),
    spans.filter(s => s.name === "buildSymbolTable").reduce((sum, s) => sum + s.durationMs, 0),
    totalMs, indexWrites);
  lines.push("════════════════════════════════════════════════════════");

  return lines.join("\n");
}

/** Reset all profiling state. Useful between test runs. */
export function reset(): void {
  if (!ENABLED) return;
  spans = [];
  pending = [];
  counters = freshCounters();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtMs(ms: number): string {
  if (ms < 1) return `${Math.round(ms * 1000)}µs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
