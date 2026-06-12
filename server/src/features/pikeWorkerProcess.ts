/**
 * PikeWorkerProcess: subprocess lifecycle management for the Pike worker.
 *
 * Handles spawning, stopping, stdin/stdout, response parsing, idle eviction,
 * and memory ceiling checks. PikeWorker (the public API) extends this class.
 *
 * Extracted from pikeWorker.ts to keep each file under 500 lines.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { LSPErrorCodes } from "vscode-languageserver-protocol/lib/common/api";
import type {
  PikeWorkerConfig,
  PikeResponse,
  QueueItem,
} from "./pikeWorkerTypes.js";
import {
  DEFAULT_CONFIG,
  PikeUnavailableError,
} from "./pikeWorkerTypes.js";
import { shouldEvictIdle, shouldForceRestart as checkForceRestart } from "./pikeWorkerLifecycle.js";
import { processResponseBuffer } from "./pikeWorkerResponseParser.js";
import { handlePikeStderr } from "./pikeWorkerStderr.js";
import {
  buildSpawnCommand,
  assertHarnessReady,
} from "./pikeWorkerPaths.js";
import {
  PikeWorkerHealthMonitor,
  isIdleEvictionCandidate,
  CRASH_BACKOFF_THRESHOLD,
  CRASH_BACKOFF_MS,
} from "./pikeWorkerHealth.js";

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

  // Health monitoring (heartbeat, crash-backoff, health-checks — US3 ADR 0032)
  protected readonly health = new PikeWorkerHealthMonitor();

  protected readonly config: PikeWorkerConfig;

  // Priority queue — exactly one write to stdin at a time. O(1) enqueue/dequeue.
  protected readonly queues: [QueueItem[], QueueItem[], QueueItem[]] = [[], [], []];
  protected sending = false;

  // Idle eviction
  protected idleTimer: ReturnType<typeof setTimeout> | null = null;
  protected lastRequestTime = 0;

  // Memory ceiling tracking
  protected requestCount = 0;
  protected startTime = 0;

  // Pike binary availability: null=unknown, true=available, false=not found (exit 127).
  protected pikeAvailable: boolean | null = null;

  pikeVersion: string | null = null;

  // Callbacks set by the server after construction.
  protected onCriticalError: ((ctx: string, err: unknown) => void) | null = null;
  protected onWarning: ((ctx: string, msg: string) => void) | null = null;
  protected warnedAboutMissingLibs = false;

  constructor(config?: Partial<PikeWorkerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  setErrorHandler(handler: (ctx: string, err: unknown) => void): void {
    this.onCriticalError = handler;
  }

  setWarningHandler(handler: (ctx: string, msg: string) => void): void {
    this.onWarning = handler;
  }

  updateConfig(config: Partial<PikeWorkerConfig>): void {
    Object.assign(this.config, config);
  }

  /** Start the Pike worker process (lazy — called on first request). */
  start(): void {
    if (this.proc && !this.proc.killed) return;

    assertHarnessReady();

    const { cmd, args, cwd, env } = buildSpawnCommand(
      this.config.pikeBinaryPath,
      this.config.niceValue,
      this.config.libraryPath,
    );

    this.proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], cwd, env });

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
        consecutiveCrashes: this.health.consecutiveCrashCount,
        config: this.config,
        onCriticalError: this.onCriticalError,
        onWarning: this.onWarning,
        crashBackoffThreshold: CRASH_BACKOFF_THRESHOLD,
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
          const shouldBackoff = this.health.recordCrash();
          if (shouldBackoff) {
            this.onWarning?.(
              "worker.crashBackoff",
              `Pike worker crashed ${this.health.consecutiveCrashCount} times in a row — ` +
              `pausing diagnostics for ${CRASH_BACKOFF_MS / 1000}s. ` +
              `This is likely a Pike compiler bug (check stderr for "Fatal error").`,
            );
          }
        }

        // Reject pending requests with typed error
        const error = code === 127
          ? new PikeUnavailableError()
          : new Error(`Pike worker exited (code=${code}, signal=${signal})`);
        this.rejectAllPending(error);
        this.rejectAllQueued(error);
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
   * Stop the Pike worker. SIGTERM then SIGKILL after 3s to prevent zombies.
   */
  stop(): void {
    this.clearIdleTimer();
    this.stopHeartbeat();
    if (this.proc && !this.proc.killed) {
      const dying = this.proc;
      dying.kill("SIGTERM");
      // Force-kill after grace period. kill() is idempotent on dead processes.
      const forceTimer = setTimeout(() => {
        if (!dying.killed) dying.kill("SIGKILL");
      }, 3000);
      forceTimer.unref();
    }
    this.proc = null;

    // Reject all pending requests — the exit handler won't fire because
    // stop() nulls this.proc before the async exit event arrives.
    this.rejectAllPending(new Error("Pike worker stopped"));
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

  /** Reject all pending requests and clear the pending map. */
  protected rejectAllPending(error: Error): void {
    if (this.pending.size === 0) return;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  /** Reject all queued items across all priority sub-queues. */
  protected rejectAllQueued(error: Error): void {
    for (const q of this.queues) {
      for (const item of q) {
        clearTimeout(item.timeout);
        item.reject(error);
      }
      q.length = 0;
    }
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
   * A hung process gets SIGKILL — SIGTERM may never deliver under load.
   * Rejects all pending/queued requests truthfully.
   */
  forceKillForTimeout(timedOutRequestId: number): void {
    if (!this.proc || this.proc.killed) return;

    const dying = this.proc;
    this.onWarning?.(
      "worker.timeoutForceKill",
      `Request id=${timedOutRequestId} timed out — force-killing Pike process (pid=${dying.pid})`,
    );

    // Null proc so the exit handler knows this is intentional.
    this.proc = null;
    try { dying.kill("SIGKILL"); } catch { /* may have already exited */ }

    this.rejectAllPending(
      new Error(`Pike worker force-killed after timeout on request id=${timedOutRequestId}`),
    );
    this.rejectAllQueued(new Error("Pike worker queue cleared after timeout force-kill"));
    this.sending = false;
  }

  // ---------------------------------------------------------------------------
  // Heartbeat, health-check, and backoff (US3, ADR 0032)
  // Delegated to PikeWorkerHealthMonitor.
  // ---------------------------------------------------------------------------

  get isHeartbeatActive(): boolean {
    return this.health.isHeartbeatActive;
  }

  startHeartbeat(): void {
    this.health.startHeartbeat(() => this.proc, this.config.heartbeatIntervalMs ?? 30_000);
  }

  stopHeartbeat(): void {
    this.health.stopHeartbeat();
  }

  get consecutiveHealthCheckFailures(): number {
    return this.health.consecutiveHealthCheckFailures;
  }

  recordHealthCheckFailure(): void {
    this.health.recordHealthCheckFailure();
  }

  recordHealthCheckSuccess(): void {
    this.health.recordHealthCheckSuccess();
  }

  static computeBackoffDelayMs(
    attempt: number,
    baseMs: number,
    maxMs: number,
  ): number {
    return PikeWorkerHealthMonitor.computeBackoffDelayMs(attempt, baseMs, maxMs);
  }

  isIdleEvictionCandidate(thresholdMs: number): boolean {
    return isIdleEvictionCandidate(this.proc, this.lastRequestTime, thresholdMs);
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
          this.health.resetCrashes();
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
