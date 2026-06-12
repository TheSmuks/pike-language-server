/**
 * PikeWorkerProcess: subprocess lifecycle management for the Pike worker.
 *
 * Handles spawning, stopping, stdin/stdout, response parsing, idle eviction,
 * and memory ceiling checks. PikeWorker (the public API) extends this class.
 *
 * Extracted from pikeWorker.ts to keep each file under 500 lines.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { LSPErrorCodes } from "vscode-languageserver-protocol/lib/common/api";
import type {
  PikeWorkerConfig,
  PikeResponse,
  QueueItem,
} from "./pikeWorkerTypes.js";
import {
  DEFAULT_CONFIG,
  PikeUnavailableError,
  clampPriority,
} from "./pikeWorkerTypes.js";
import { shouldEvictIdle, shouldForceRestart as checkForceRestart } from "./pikeWorkerLifecycle.js";
import { processResponseBuffer } from "./pikeWorkerResponseParser.js";
import { handlePikeStderr } from "./pikeWorkerStderr.js";
import { HARNESS_DIR, WORKER_SCRIPT, INTROSPECT_PATH, VSIX_ROOT, DEV_ROOT } from "./pikeWorkerPaths.js";

// ---------------------------------------------------------------------------
// PikeWorkerProcess — base class for subprocess lifecycle
// ---------------------------------------------------------------------------

export abstract class PikeWorkerProcess {

  protected proc: ChildProcess | null = null;
  protected requestId = 0;
  protected pending = new Map<number, {
    resolve: (response: PikeResponse) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  protected buffer = "";
  protected restarting = false;
  protected consecutiveMalformed = 0;
  protected static readonly MALFORMED_RESTART_THRESHOLD = 5;
  /**
   * Tracks consecutive Pike process crashes (exit with non-zero, non-127 code).
   * Used to prevent crash loops: if Pike crashes repeatedly, we stop
   * auto-restarting until the backoff period expires.
   */
  protected consecutiveCrashes = 0;
  protected static readonly CRASH_BACKOFF_THRESHOLD = 3;
  protected static readonly CRASH_BACKOFF_MS = 30_000;
  protected crashBackoffUntil = 0;
  protected readonly config: PikeWorkerConfig;

  // Priority queue — ensures exactly one write to stdin at a time.
  // Three FIFO sub-queues indexed by PikePriority value. O(1) enqueue and dequeue.
  protected readonly queues: [QueueItem[], QueueItem[], QueueItem[]] = [[], [], []];
  protected sending = false;

  // Idle eviction
  protected idleTimer: ReturnType<typeof setTimeout> | null = null;
  protected lastRequestTime = 0;

  // Heartbeat (US3 ADR 0032)
  protected heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // Health-check tracking (US3 ADR 0032)
  protected healthCheckFailures = 0;

  // Memory ceiling tracking
  protected requestCount = 0;
  protected startTime = 0;

  /**
   * Tracks Pike binary availability:
   * - null = unknown (not yet attempted)
   * - true = available (spawn succeeded)
   * - false = unavailable (exit code 127 or pike not found)
   */
  protected pikeAvailable: boolean | null = null;

  /**
   * Pike version string from the last successful ping. Null until warmUp succeeds.
   * Used for version-aware feature gating and mismatch warnings.
   */
  pikeVersion: string | null = null;

  /**
   * Callback for critical errors that should be routed through the centralized
   * error log. Set by the server after construction via `setErrorHandler`.
   * Signature: (ctx: string, err: unknown) => void.
   */
  protected onCriticalError: ((ctx: string, err: unknown) => void) | null = null;
  /**
   * Callback for non-fatal warnings that should be routed through the
   * centralized log. Set by the server after construction.
   */
  protected onWarning: ((ctx: string, msg: string) => void) | null = null;
  /**
   * Tracks whether we have already warned about a missing library warning
   * from Nettle.so. Used to show the user a one-time actionable message
   * instead of spamming errors on every stderr line.
   */
  protected warnedAboutMissingLibs = false;

  constructor(config?: Partial<PikeWorkerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Install the error handler that routes PikeWorker errors through the
   * centralized errorLog. Call this once after the server has a Connection.
   */
  setErrorHandler(handler: (ctx: string, err: unknown) => void): void {
    this.onCriticalError = handler;
  }

  /**
   * Install the warning handler for non-fatal advisory messages.
   * Call this once after the server has a Connection.
   */
  setWarningHandler(handler: (ctx: string, msg: string) => void): void {
    this.onWarning = handler;
  }

  /** Update configuration. Only effective before the worker starts (lazy). */
  updateConfig(config: Partial<PikeWorkerConfig>): void {
    Object.assign(this.config, config);
  }

  /** Start the Pike worker process (lazy — called on first request). */
  start(): void {
    if (this.proc && !this.proc.killed) return;

    // Guard: fail fast if harness is not found in any expected location.
    if (!HARNESS_DIR) throw new Error(
      `Pike worker: harness directory not found.\n` +
      `  Dev layout: ${join(DEV_ROOT, "harness")}\n` +
      `  VSIX layout: ${join(VSIX_ROOT, "harness")}`,
    );
    if (!WORKER_SCRIPT) throw new Error(
      `Pike worker: worker.pike not found.\n` +
      `  Dev layout: ${join(DEV_ROOT, "harness", "worker.pike")}\n` +
      `  VSIX layout: ${join(VSIX_ROOT, "harness", "worker.pike")}`,
    );

    // Build argument list: always include HARNESS_DIR, conditionally include INTROSPECT_PATH.
    const baseArgs = ["-M", HARNESS_DIR];
    if (INTROSPECT_PATH) baseArgs.push("-M", INTROSPECT_PATH);
    baseArgs.push(WORKER_SCRIPT);

    // On Linux, use nice for CPU politeness under contention
    let finalCmd: string;
    let finalArgs: string[];

    if (this.config.niceValue > 0 && process.platform === "linux") {
      finalCmd = "nice";
      finalArgs = ["-n" + this.config.niceValue, this.config.pikeBinaryPath, ...baseArgs];
    } else {
      finalCmd = this.config.pikeBinaryPath;
      finalArgs = baseArgs;
    }

    // Use the resolved root as cwd; prefer VSIX root if available.
    const cwd = VSIX_ROOT || DEV_ROOT;
    // Build the environment for the Pike worker. Merge libraryPath into
    // LD_LIBRARY_PATH so Pike's native modules can find shared libraries
    // that are not on the default linker search path.
    const spawnEnv = { ...process.env } as typeof process.env;
    if (this.config.libraryPath) {
      const base = process.env.LD_LIBRARY_PATH ?? "";
      spawnEnv.LD_LIBRARY_PATH = base
        ? `${this.config.libraryPath}:${base}`
        : this.config.libraryPath;
    }

    this.proc = spawn(finalCmd, finalArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
      env: spawnEnv,
    });

    const stdout = this.proc.stdout;
    const stderr = this.proc.stderr;
    if (!stdout || !stderr) {
      throw new Error("Pike worker: failed to create stdio streams");
    }
    stdout.on("data", (data: Buffer) => {
      this.buffer += data.toString();
      // Guard against unbounded buffer growth (e.g. Pike binary dump without newlines).
      if (this.buffer.length > 1_000_000) {
        this.buffer = "";
        this.onCriticalError?.("worker.bufferOverflow", new Error("Response buffer exceeded 1MB — clearing"));
      }
      this.processBuffer();
    });

    stderr.on("data", (data: Buffer) => {
      this.warnedAboutMissingLibs = handlePikeStderr(data.toString().trim(), {
        pikeAvailable: this.pikeAvailable,
        warnedAboutMissingLibs: this.warnedAboutMissingLibs,
        consecutiveCrashes: this.consecutiveCrashes,
        config: this.config,
        onCriticalError: this.onCriticalError,
        onWarning: this.onWarning,
        crashBackoffThreshold: PikeWorkerProcess.CRASH_BACKOFF_THRESHOLD,
      });
    });

    const exitingProc = this.proc;

    this.proc.on("exit", (code, signal) => {
      this.clearIdleTimer();
      // Only reject pending if this is the CURRENT proc (not an old one
      // that was killed during a restart cycle)
      if (!this.restarting && this.proc === exitingProc) {
        // Detect "binary not found" (exit code 127 on Linux)
        if (code === 127) {
          this.pikeAvailable = false;
        }

        // Track consecutive crashes (non-zero, non-127 exit) to prevent
        // infinite crash loops when Pike hits an internal fatal error.
        if (code !== 0 && code !== 127) {
          this.consecutiveCrashes++;
          if (this.consecutiveCrashes >= PikeWorkerProcess.CRASH_BACKOFF_THRESHOLD) {
            this.crashBackoffUntil = Date.now() + PikeWorkerProcess.CRASH_BACKOFF_MS;
            this.onWarning?.(
              "worker.crashBackoff",
              `Pike worker crashed ${this.consecutiveCrashes} times in a row — ` +
              `pausing diagnostics for ${PikeWorkerProcess.CRASH_BACKOFF_MS / 1000}s. ` +
              `This is likely a Pike compiler bug (check stderr for "Fatal error").`,
            );
          }
        }

        // Reject pending requests with typed error
        const error = code === 127
          ? new PikeUnavailableError()
          : new Error(`Pike worker exited (code=${code}, signal=${signal})`);
        for (const [, pending] of this.pending) {
          clearTimeout(pending.timeout);
          pending.reject(error);
        }
        this.pending.clear();
        // Also reject everything still in the queue
        for (const q of this.queues) {
          for (const item of q) {
            clearTimeout(item.timeout);
            item.reject(error);
          }
        }
        for (const q of this.queues) q.length = 0;
        this.sending = false;
        this.proc = null;
      }

    });

    // Reset tracking
    this.requestCount = 0;
    this.startTime = Date.now();
    this.buffer = "";
    this.consecutiveMalformed = 0;
  }

  /**
   * Stop the Pike worker process.
   * Sends SIGTERM first, then escalates to SIGKILL after 3 seconds if the
   * process hasn't exited. This prevents zombie Pike processes on shared
   * development servers when the worker is unresponsive.
   */
  stop(): void {
    this.clearIdleTimer();
    this.stopHeartbeat();
    if (this.proc && !this.proc.killed) {
      const dying = this.proc;
      dying.kill("SIGTERM");

      // Force-kill after grace period. Node's ChildProcess.kill() is
      // idempotent — calling it on an already-exited process is a no-op.
      const forceTimer = setTimeout(() => {
        if (!dying.killed) {
          dying.kill("SIGKILL");
        }
      }, 3000);
      // Don't let the timer prevent process exit.
      forceTimer.unref();
    }
    this.proc = null;

    // Reject all pending requests so their Promises don't leak.
    // The exit handler won't fire for this proc because stop() nulls
    // this.proc before the async exit event arrives.
    if (this.pending.size > 0) {
      const error = new Error("Pike worker stopped");
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      this.pending.clear();
    }

    for (const q of this.queues) q.length = 0;
    this.sending = false;
  }

  /** Check if the worker process is alive. */
  get isAlive(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  /**
   * Check if Pike is available.
   * - null = not yet attempted
   * - true = available
   * - false = binary not found or permanently unavailable
   */
  get isAvailable(): boolean {
    return this.pikeAvailable !== false;
  }

  /** Get current request count since last start. */
  get currentRequestCount(): number {
    return this.requestCount;
  }

  // -----------------------------------------------------------------------
  // Queue draining & stdin writing
  // -----------------------------------------------------------------------

  /**
   * Drain the priority queue.  Sends exactly one item at a time.
   * Handles stdin backpressure by waiting for the drain event.
   * Picks the item with the lowest priority number (highest priority) first.
   */
  protected drainQueue(): void {
    if (this.sending) return;
    if (!this.proc || this.proc.killed) return;

    // Drain highest-priority non-empty sub-queue first (O(1) dequeue).
    for (const q of this.queues) {
      if (q.length === 0) continue;

      const item = q.shift();
      if (!item) continue;

      // Check cancellation before writing to subprocess
      if (item.token?.isCancellationRequested) {
        const parsed: { id: number } = JSON.parse(item.payload);
        const pending = this.pending.get(parsed.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(parsed.id);
        }
        item.resolve({ id: parsed.id, error: { code: LSPErrorCodes.RequestCancelled, message: "Request cancelled" } });
        this.drainQueue();
        return;
      }

      this.sending = true;

      this.writeToStdin(item.payload).then(
        () => {
          // Write succeeded — response will be resolved by processBuffer
          // via the pending map.  Allow next item to be sent.
          this.sending = false;
          this.drainQueue();
        },
        (err) => {
          // Write failed — reject this item
          item.reject(err instanceof Error ? err : new Error(String(err)));
          this.sending = false;
          this.drainQueue();
        },
      );

      // Found an item to send — stop scanning sub-queues.
      return;
    }
  }

  /**
   * Write a payload to stdin, respecting backpressure.
   * If the write returns false (buffer full), wait for the drain event.
   */
  protected writeToStdin(payload: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.killed || !this.proc.stdin) {
        reject(new Error("Pike worker process not available"));
        return;
      }
      const stdin = this.proc.stdin;
      if (!stdin.write(payload)) {
        const onDrain = () => { cleanup(); resolve(); };
        const onError = (err: Error) => { cleanup(); reject(err); };
        const cleanup = () => {
          stdin.removeListener("drain", onDrain);
          stdin.removeListener("error", onError);
        };
        stdin.once("drain", onDrain);
        stdin.once("error", onError);
      } else {
        resolve();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Idle eviction
  // ---------------------------------------------------------------------------

  /**
   * Reset the idle eviction timer. Called on every request and by the heartbeat
   * manager to keep the worker alive during active use. Public so external
   * callers (heartbeat/watchdog) can indicate activity.
   */
  resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (shouldEvictIdle(this.proc, this.pending.size, this.queues.map(q => q.length))) {
        this.stop();
      }
    }, this.config.idleTimeoutMs);
    if (this.idleTimer?.unref) this.idleTimer.unref();
    this.lastRequestTime = Date.now();
  }

  protected clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Memory ceiling check
  // ---------------------------------------------------------------------------

  protected shouldForceRestart(): boolean {
    return checkForceRestart(
      this.proc, this.requestCount,
      this.config.maxRequestsBeforeRestart,
      this.startTime, this.config.maxActiveMinutes,
    );
  }

  // ---------------------------------------------------------------------------
  // Force-kill for timeout (T037/T038)
  // ---------------------------------------------------------------------------

  /**
   * Force-kill the Pike process when a request times out.
   *
   * A timed-out request means the process is stuck (infinite loop, deadlock,
   * or waiting on unreachable I/O). SIGTERM may never deliver because Pike's
   * signal handling is unreliable under load. SIGKILL is the only safe option.
   *
   * Rejects ALL pending requests truthfully — they will never get responses
   * from the killed process. The next request will lazily spawn a fresh one.
   */
  forceKillForTimeout(timedOutRequestId: number): void {
    if (!this.proc || this.proc.killed) return;

    const dying = this.proc;
    this.onWarning?.(
      "worker.timeoutForceKill",
      `Request id=${timedOutRequestId} timed out — force-killing Pike process (pid=${dying.pid})`,
    );

    // Null the proc reference so the exit handler knows this is an intentional kill.
    this.proc = null;

    // Send SIGKILL immediately — no grace period for a hung process.
    try {
      dying.kill("SIGKILL");
    } catch {
      // Process may have already exited.
    }

    // Reject all remaining pending requests — they will never get responses.
    if (this.pending.size > 0) {
      const error = new Error(
        `Pike worker force-killed after timeout on request id=${timedOutRequestId}`,
      );
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      this.pending.clear();
    }

    // Clear the queue — nothing can be sent to a dead process.
    for (const q of this.queues) {
      for (const item of q) {
        clearTimeout(item.timeout);
        item.reject(new Error("Pike worker queue cleared after timeout force-kill"));
      }
      q.length = 0;
    }
    this.sending = false;
  }

  // ---------------------------------------------------------------------------
  // Heartbeat, health-check, and backoff (US3, ADR 0032)
  // ---------------------------------------------------------------------------

  /**
   * Whether the heartbeat interval is currently active.
   * The heartbeat sends periodic "heartbeat" notifications to the Pike worker
   * so it can self-terminate if the LSP server crashes or hibernates.
   */
  get isHeartbeatActive(): boolean {
    return this.heartbeatTimer !== null;
  }

  /**
   * Start sending heartbeat notifications at the configured interval.
   * No-op if already active.
   */
  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    const interval = this.config.heartbeatIntervalMs ?? 30_000;
    this.heartbeatTimer = setInterval(() => {
      if (!this.proc || this.proc.killed) return;
      // Send heartbeat as a fire-and-forget write — no response expected.
      try {
        this.proc.stdin?.write(JSON.stringify({ method: "heartbeat" }) + "\n");
      } catch {
        // Process may have died between the alive check and the write.
      }
    }, interval);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  /**
   * Stop the heartbeat interval. Safe to call when no heartbeat is active.
   * Also called during stop() and shutdown to prevent timer leaks.
   */
  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

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

  /**
   * Check whether the worker is idle long enough to be evicted.
   * Returns true if the worker is alive and has been idle (no requests) for
   * at least thresholdMs milliseconds.
   */
  isIdleEvictionCandidate(thresholdMs: number): boolean {
    if (!this.proc || this.proc.killed) return false;
    if (this.lastRequestTime === 0) return false;
    return Date.now() - this.lastRequestTime >= thresholdMs;
  }

  // ---------------------------------------------------------------------------
  // Internal: response parsing
  // ---------------------------------------------------------------------------

  protected processBuffer(): void {
    this.buffer = processResponseBuffer(
      this.buffer,
      this.pending,
      {
        malformedRestartThreshold: PikeWorkerProcess.MALFORMED_RESTART_THRESHOLD,
        onCriticalError: this.onCriticalError,
        onResponse: (response: PikeResponse) => {
          this.consecutiveMalformed = 0;
          // Successful response means the worker is healthy — reset crash counter.
          this.consecutiveCrashes = 0;
          const pending = this.pending.get(response.id);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pending.delete(response.id);
            pending.resolve(response);
          } else {
            console.debug(`[pike-worker] Discarding response for timed-out request id=${response.id}`);
          }
        },
        onMalformed: (err, line, consecutiveMalformed) => {
          this.consecutiveMalformed = consecutiveMalformed;
          this.onCriticalError?.(
            "worker.malformedResponse",
            new Error(`Malformed response (${consecutiveMalformed}/${PikeWorkerProcess.MALFORMED_RESTART_THRESHOLD}): ${String(err).slice(0, 200)} | line=${line.slice(0, 200)}`),
          );
          if (consecutiveMalformed >= PikeWorkerProcess.MALFORMED_RESTART_THRESHOLD) {
            this.onCriticalError?.("worker.malformedThreshold", new Error("Too many malformed responses"));
            this.consecutiveMalformed = 0;
            this.restart().catch((restartErr) => {
              this.onCriticalError?.('worker.autoRestart', restartErr);
            });
          }
        },
      },
    );
  }

  // Abstract method: subclass (PikeWorker) provides restart with its enqueue/ping logic
  abstract restart(): Promise<void>;
}
