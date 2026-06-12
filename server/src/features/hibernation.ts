/**
 * Hibernation state machine for idle LSP sessions (US4, ADR 0033).
 *
 * After a configurable idle period with no open documents and no real
 * activity (requests, document opens), the server enters hibernation:
 *   - Cancels background indexing and on-demand work.
 *   - Saves the cache with a bounded deadline (best-effort).
 *   - Clears in-memory index entries (dependency map stubs remain).
 *   - Stops the Pike worker (no heartbeat, no process).
 *
 * The LSP process stays alive — VSCode Remote reliability requires this.
 * On the next request, a lazy wake gate rehydrates open-file entries.
 * Full/auto re-indexing resumes only after sustained activity, not on a
 * single wake-up request.
 *
 * Watched-file events do NOT reset the idle timer when no documents are open.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface HibernationConfig {
  /**
   * Idle timeout in milliseconds. If no real activity (requests, document
   * opens/closes) occurs within this window and no documents are open, the
   * server hibernates. 0 disables hibernation entirely.
   * Default: 900,000 (15 min).
   */
  idleTimeoutMs: number;

  /**
   * Maximum time to spend saving the cache during hibernation. Best-effort:
   * if the save exceeds this deadline, it is abandoned and the hibernation
   * proceeds. The process must not hang on a slow disk.
   * Default: 1,500 (1.5s).
   */
  saveDeadlineMs: number;

  /**
   * Window for counting sustained activity after wake. Activity within this
   * window counts toward the sustained-activity threshold.
   * Default: 60,000 (60s).
   */
  sustainedActivityWindowMs: number;

  /**
   * Minimum request count within sustainedActivityWindowMs to qualify as
   * "sustained activity" that triggers a delayed full reindex.
   * Default: 5.
   */
  sustainedActivityCount: number;
}

export const HIBERNATION_DEFAULTS: HibernationConfig = {
  idleTimeoutMs: 900_000,
  saveDeadlineMs: 1_500,
  sustainedActivityWindowMs: 60_000,
  sustainedActivityCount: 5,
};

// ---------------------------------------------------------------------------
// Callbacks — the manager drives the server via these hooks
// ---------------------------------------------------------------------------

export interface HibernationCallbacks {
  /** Cancel all background indexing and on-demand work. */
  onCancelBackgroundIndex: () => void | Promise<void>;

  /**
   * Save the persistent cache. Must respect the save deadline — the manager
   * wraps this in a timeout guard. May throw; the manager catches and
   * proceeds with hibernation.
   */
  onSaveCache: () => void | Promise<void>;

  /** Clear in-memory index entries (keep dependency map stubs). */
  onClearIndex: () => void;

  /** Stop the Pike worker process and heartbeat. */
  onStopWorker: () => void;

  /**
   * Called when a wake begins. Should rehydrate open-file entries from cache
   * or source. After this resolves, the server is ready to handle requests.
   */
  onWakeStart: () => void | Promise<void>;

  /**
   * Called when sustained activity is detected after wake. Should trigger a
   * delayed full/auto reindex. Called at most once per wake cycle.
   */
  onSustainedActivity: () => void;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type HibernationStatus = "active" | "hibernating" | "hibernated" | "waking";

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/**
 * Fake-clock compatible: all time reads go through the injected `nowFn`.
 * Default is `Date.now()`. Tests inject a controllable function.
 */
export class HibernationManager {
  private _status: HibernationStatus = "active";
  private readonly config: HibernationConfig;
  private readonly callbacks: HibernationCallbacks;
  private readonly nowFn: () => number;

  private lastRealActivityAtMs: number;
  private openDocs = 0;

  // Activity timestamps for sustained-activity detection.
  private activityTimestamps: number[] = [];
  private sustainedActivityFired = false;
  private wakeInProgress: Promise<void> | null = null;

  constructor(
    config: HibernationConfig,
    callbacks: HibernationCallbacks,
    nowFn: () => number = Date.now,
  ) {
    this.config = config;
    this.callbacks = callbacks;
    this.nowFn = nowFn;
    this.lastRealActivityAtMs = nowFn();
  }

  get status(): HibernationStatus {
    return this._status;
  }

  get openDocumentCount(): number {
    return this.openDocs;
  }

  // -----------------------------------------------------------------------
  // Activity tracking
  // -----------------------------------------------------------------------

  /**
   * Record real activity: a request, document open, document close.
   * Resets the idle timer. Does NOT count watched-file events.
   */
  recordActivity(): void {
    this.lastRealActivityAtMs = this.nowFn();

    // Track for sustained-activity detection (only when active).
    if (this._status === "active") {
      const now = this.nowFn();
      this.activityTimestamps.push(now);
      this.pruneActivityWindow(now);

      // Check sustained activity threshold.
      if (
        !this.sustainedActivityFired &&
        this.activityTimestamps.length >= this.config.sustainedActivityCount
      ) {
        this.sustainedActivityFired = true;
        this.callbacks.onSustainedActivity();
      }
    }
  }

  /** Increment open document count. Documents prevent hibernation. */
  onDocumentOpen(): void {
    this.openDocs++;
    this.recordActivity();
  }

  /** Decrement open document count. */
  onDocumentClose(): void {
    if (this.openDocs > 0) this.openDocs--;
    this.recordActivity();
  }

  /**
   * Watched-file event. Resets idle timer ONLY when documents are open.
   * When no documents are open, the event is noted but does NOT keep the
   * server awake. This prevents external file churn from preventing
   * hibernation of idle remote sessions.
   */
  onWatchedFileEvent(): void {
    if (this.openDocs > 0) {
      this.recordActivity();
    }
    // No-op when no documents are open — idle timer continues counting.
  }

  // -----------------------------------------------------------------------
  // Idle check and hibernation
  // -----------------------------------------------------------------------

  /**
   * Check whether the idle timer has expired and trigger hibernation if so.
   * Called periodically by the server's timer or after events.
   *
   * Does nothing if: hibernation is disabled (idleTimeoutMs=0), documents are
   * open, or already hibernated.
   *
   * Returns a promise that resolves when hibernation completes (or immediately
   * if no hibernation is triggered). Callers should await this to ensure the
   * status is settled.
   */
  async checkIdleTimeout(): Promise<void> {
    if (this._status !== "active") return;
    if (this.config.idleTimeoutMs === 0) return;
    if (this.openDocs > 0) return;

    const idleFor = this.nowFn() - this.lastRealActivityAtMs;
    if (idleFor < this.config.idleTimeoutMs) return;

    await this.hibernateNow();
  }

  /**
   * Force hibernation immediately, regardless of idle timer.
   * Used by checkIdleTimeout and by explicit shutdown paths.
   *
   * Steps (per ADR 0033):
   * 1. Set status to hibernating (internal transition).
   * 2. Cancel background indexing.
   * 3. Save cache with deadline guard.
   * 4. Clear in-memory index.
   * 5. Stop Pike worker + heartbeat.
   * 6. Set status to hibernated.
   */
  async hibernateNow(): Promise<void> {
    // Guard against double-hibernation.
    if (this._status !== "active") return;

    this._status = "hibernating";

    // Cancel background work first — stop new work from entering.
    try {
      await this.callbacks.onCancelBackgroundIndex();
    } catch {
      // Cancellation failure is not fatal to hibernation.
    }

    // Save cache with a deadline guard.
    await this.saveCacheWithDeadline();

    // Clear in-memory index entries.
    this.callbacks.onClearIndex();

    // Stop the Pike worker — no process, no heartbeat.
    this.callbacks.onStopWorker();

    this._status = "hibernated";
  }

  /**
   * Save the cache, but enforce a deadline. If the save takes longer than
   * saveDeadlineMs, abandon it and proceed. Catches errors so a failing
   * save doesn't prevent hibernation.
   */
  private async saveCacheWithDeadline(): Promise<void> {
    const savePromise = this.callbacks.onSaveCache();
    const deadlinePromise = new Promise<void>((resolve) =>
      setTimeout(resolve, this.config.saveDeadlineMs),
    );

    try {
      await Promise.race([savePromise, deadlinePromise]);
    } catch {
      // Save failed — proceed with hibernation anyway.
      // The cache is best-effort; the server still hibernates honestly.
    }
  }

  // -----------------------------------------------------------------------
  // Wake / rehydration
  // -----------------------------------------------------------------------

  /**
   * Gate called before processing a request. If hibernated, triggers wake
   * rehydration. If already active, returns immediately (no-op).
   *
   * Concurrent calls to wakeGate coalesce — only one rehydration runs.
   * All callers await the same promise.
   */
  async wakeGate(): Promise<void> {
    if (this._status !== "hibernated") return;

    // Coalesce concurrent wake requests.
    if (this.wakeInProgress) {
      await this.wakeInProgress;
      return;
    }

    this._status = "waking";
    this.wakeInProgress = this.performWake();

    try {
      await this.wakeInProgress;
    } finally {
      this.wakeInProgress = null;
    }
  }

  /**
   * Perform the actual wake: rehydrate open files and return to active.
   * Resets sustained-activity tracking for the new wake cycle.
   */
  private async performWake(): Promise<void> {
    try {
      await this.callbacks.onWakeStart();
    } finally {
      // Reset activity tracking for the new active period.
      this.activityTimestamps = [];
      this.sustainedActivityFired = false;
      this.lastRealActivityAtMs = this.nowFn();
      this._status = "active";
    }
  }

  // -----------------------------------------------------------------------
  // Sustained activity detection
  // -----------------------------------------------------------------------

  /**
   * True if sustained activity has been detected since the last wake.
   * The server uses this to decide whether to trigger a full reindex.
   */
  isSustainedActivity(): boolean {
    const now = this.nowFn();
    this.pruneActivityWindow(now);
    return this.activityTimestamps.length >= this.config.sustainedActivityCount;
  }

  /**
   * Remove activity timestamps older than the sustained-activity window.
   * Keeps the array bounded — at most sustainedActivityCount entries need
   * to be retained.
   */
  private pruneActivityWindow(now: number): void {
    const cutoff = now - this.config.sustainedActivityWindowMs;
    this.activityTimestamps = this.activityTimestamps.filter(
      (t) => t >= cutoff,
    );
  }
}
