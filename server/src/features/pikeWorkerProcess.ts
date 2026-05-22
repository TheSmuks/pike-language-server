/**
 * PikeWorkerProcess: subprocess lifecycle management for the Pike worker.
 *
 * Handles spawning, stopping, stdin/stdout, response parsing, idle eviction,
 * and memory ceiling checks. PikeWorker (the public API) extends this class.
 *
 * Extracted from pikeWorker.ts to keep each file under 500 lines.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, statSync } from "node:fs";
import { LSPErrorCodes } from "vscode-languageserver-protocol/lib/common/api";
import {
  validatePikeResponse,
} from "../util/jsonValidation.js";
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

// ---------------------------------------------------------------------------
// Path resolution helpers
// ---------------------------------------------------------------------------

const _thisDir = typeof __dirname !== 'undefined'
  ? __dirname
  : dirname(fileURLToPath(import.meta.url));

/**
 * Resolve a directory by trying multiple candidate paths.
 * Returns the first path that exists and is a directory, or undefined.
 *
 * Supports both dev layout and VSIX layout:
 * - Dev:       server/dist/ → 3 levels up → repo root
 * - VSIX:      server/dist/ → 2 levels up → extension root
 */
function resolveDir(...candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // Permission or access errors — treat as non-existent.
    }
  }
  return undefined;
}

/**
 * Resolve a file by trying multiple candidate paths.
 * Returns the first path that exists and is a file, or undefined.
 */
function resolveFile(...candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Permission or access errors — treat as non-existent.
    }
  }
  return undefined;
}

// Dev layout: _thisDir = server/dist/; 3× ".." = repo root
const DEV_ROOT = resolve(_thisDir, "..", "..", "..");
// VSIX layout: _thisDir = server/dist/; 2× ".." = extension root
const VSIX_ROOT = resolve(_thisDir, "..", "..");

const HARNESS_DIR = resolveDir(
  join(DEV_ROOT, "harness"),
  join(VSIX_ROOT, "harness"),
);
const WORKER_SCRIPT = resolveFile(
  join(DEV_ROOT, "harness", "worker.pike"),
  join(VSIX_ROOT, "harness", "worker.pike"),
);
const INTROSPECT_PATH = resolveDir(
  join(DEV_ROOT, "modules", "Introspect", "src"),
);

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
      this.processBuffer();
    });

    stderr.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (!msg) return;

      // Suppress stderr logging once Pike is known to be unavailable.
      if (this.pikeAvailable === false) return;

      // Detect the specific Nettle/libhogweed missing-library warning.
      // Pike prints this to stderr but continues running — it is not fatal.
      // Show the user a one-time actionable message instead of spamming
      // every stderr line as a critical error.
      // Use exec() instead of RegExp.$1 — the static property is deprecated
      // and unsafe under async concurrency (any intervening regex overwrites it).
      const libMatch = /Failed to load library: (lib[\w-]+\.so[\d.]*)/.exec(msg);
      if (
        !this.warnedAboutMissingLibs &&
        libMatch
      ) {
        const libName = libMatch[1];
        this.warnedAboutMissingLibs = true;
        if (this.config.libraryPath) {
          this.onWarning?.(
            "worker.missingLibrary",
            `Failed to load ${libName} — the configured ` +
            `pike.languageServer.worker.ldLibraryPath ` +
            `("${this.config.libraryPath}") may not contain it.`,
          );
        } else {
          this.onWarning?.(
            "worker.missingLibrary",
            `Failed to load ${libName}. ` +
            `Set pike.languageServer.worker.ldLibraryPath to the directory ` +
            `containing this library (e.g. /usr/lib/x86_64-linux-gnu).`,
          );
        }
        return;
      }

      // Detect Pike internal fatal errors (e.g. "pike_types.c:707: Fatal error:
      // Type mark stack underflow"). These indicate bugs in Pike itself, not in
      // the LSP. Log as a warning (not error) since the crash-loop backoff
      // mechanism handles the recovery.
      const isFatalPikeError = /Fatal error:/i.test(msg);
      if (isFatalPikeError) {
        // Suppress duplicate fatal errors during crash loops — the backoff
        // mechanism already warned the user.
        if (this.consecutiveCrashes >= PikeWorkerProcess.CRASH_BACKOFF_THRESHOLD) {
          return;
        }
        this.onWarning?.("worker.pikeFatal", `[pike-worker stderr] ${msg}`);
        return;
      }

      // Other stderr output — route as a critical error (but only once Pike
      // is confirmed available; during startup pikeAvailable is null).
      this.onCriticalError?.("worker.stderr", new Error(`[pike-worker stderr] ${msg}`));
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
  }

  /**
   * Stop the Pike worker process.
   * Sends SIGTERM first, then escalates to SIGKILL after 3 seconds if the
   * process hasn't exited. This prevents zombie Pike processes on shared
   * development servers when the worker is unresponsive.
   */
  stop(): void {
    this.clearIdleTimer();
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

  protected resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (shouldEvictIdle(this.proc, this.pending.size, this.queues.map(q => q.length))) {
        this.stop();
      }
    }, this.config.idleTimeoutMs);
    if (this.idleTimer?.unref) this.idleTimer.unref();
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
  // Internal: response parsing
  // ---------------------------------------------------------------------------

  protected processBuffer(): void {
    while (true) {
      const newlineIdx = this.buffer.indexOf("\n");
      if (newlineIdx === -1) break;

      const line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (!line.trim()) continue;

      try {
        const raw: unknown = JSON.parse(line);
        const response = validatePikeResponse(raw);
        this.consecutiveMalformed = 0;
        // Successful response means the worker is healthy — reset crash counter.
        this.consecutiveCrashes = 0;
        const pending = this.pending.get(response.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(response.id);
          pending.resolve(response);
        } else {
          // Response arrived after timeout — log and discard. Uses console.debug
          // because this class doesn't hold a connection reference; the message
          // appears in the server's stderr output.
          console.debug(`[pike-worker] Discarding response for timed-out request id=${response.id}`);
        }
      } catch (err) {
        // Malformed response — could be debug output or protocol corruption.
        // Count consecutive failures and restart if threshold exceeded.
        this.consecutiveMalformed++;
        this.onCriticalError?.(
          "worker.malformedResponse",
          new Error(`Malformed response (${this.consecutiveMalformed}/${PikeWorkerProcess.MALFORMED_RESTART_THRESHOLD}): ${String(err).slice(0, 200)} | line=${line.slice(0, 200)}`),
        );
        if (this.consecutiveMalformed >= PikeWorkerProcess.MALFORMED_RESTART_THRESHOLD) {
          this.onCriticalError?.("worker.malformedThreshold", new Error("Too many malformed responses"));
          this.consecutiveMalformed = 0;
          this.restart().catch((err) => {
            this.onCriticalError?.('worker.autoRestart', err);
          });
        }
      }
    }
  }

  // Abstract method: subclass (PikeWorker) provides restart with its enqueue/ping logic
  abstract restart(): Promise<void>;
}
