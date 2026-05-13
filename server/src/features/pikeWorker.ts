/**
 * PikeWorker: manages a Pike subprocess for diagnostics and type queries.
 *
 * Architecture (decision 0018 — shared-server deployment):
 * - One Pike process per LSP server instance
 * - Communication over stdio using JSON protocol (newline-delimited)
 * - Strict FIFO queue: ALL calls serialized through a single queue.
 *   No concurrent writes to stdin — exactly one request in flight at a time.
 * - stdin backpressure: writes wait for drain when the pipe buffer fills.
 * - Idle eviction: kill after N minutes of no requests (default 5)
 * - Memory ceiling: restart after N requests or M minutes of active use
 * - CPU politeness: spawned with nice +5 on Linux
 * - Timeout: 5s per request (configurable), surfaced as diagnostic on timeout
 * - Lazy start (on first request)
 * - Content-hash caching (via caller, with LRU eviction)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, statSync } from "node:fs";
import type { Connection } from "vscode-languageserver/node";
import type { CancellationToken } from "vscode-languageserver/node";
import { logError, ErrorCategory } from "../util/errorLog.js";
// ---------------------------------------------------------------------------
// Configuration (tunable per deployment)
// ---------------------------------------------------------------------------

export interface PikeWorkerConfig {
  /** Idle timeout in milliseconds before killing the worker. Default: 300000 (5 min). */
  idleTimeoutMs: number;
  /** Max requests before forced restart. Default: 100. */
  maxRequestsBeforeRestart: number;
  /** Max active minutes before forced restart. Default: 30. */
  maxActiveMinutes: number;
  /** Per-request timeout in milliseconds. Default: 5000 (5s). */
  requestTimeoutMs: number;
  /** Process nice value (Linux). Default: 5. Set to 0 to disable. */
  niceValue: number;
  /** Path to the Pike binary. Default: "pike". */
  pikeBinaryPath: string;
}

const DEFAULT_CONFIG: PikeWorkerConfig = {
  idleTimeoutMs: 5 * 60 * 1000,
  maxRequestsBeforeRestart: 100,
  maxActiveMinutes: 30,
  requestTimeoutMs: 5_000,
  niceValue: 5,
  pikeBinaryPath: process.env.PIKE_BINARY ?? "pike",
};
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PikeDiagnostic {
  line: number;
  severity: "error" | "warning";
  message: string;
  expected_type?: string;
  actual_type?: string;
  /** Optional error code from the Pike compiler. */
  code?: string;
}

export interface DiagnoseResult {
  diagnostics: PikeDiagnostic[];
  exit_code: number;
  /** Set when the request timed out — caller should surface as diagnostic. */
  timedOut?: boolean;
}

export interface AutodocResult {
  xml: string;
  error?: string;
}

export interface TypeofResult {
  type: string;
  error?: string;
}

export interface ResolveResult {
  resolved: boolean;
  name?: string;
  kind?: string;         // "class" | "function" | "module" | "variable"
  source_file?: string;
  source_line?: number;
  methods?: Array<{ name: string; source_file?: string; source_line?: number }>;
  constants?: Array<{ name: string; source_file?: string; source_line?: number }>;
  inherits?: Array<{ name: string; source_file?: string; source_line?: number }>;
  inherited_methods?: string[];
  inherited_constants?: string[];
  error?: string;
}

interface PikeRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface PikeResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}


// ---------------------------------------------------------------------------
// PikeUnavailableError
// ---------------------------------------------------------------------------

/**
 * Error thrown when Pike binary is not available.
 * Used for graceful degradation — callers can catch and fall back to
 * tree-sitter-only features without spamming error logs.
 */
export class PikeUnavailableError extends Error {
  readonly name = "PikeUnavailableError";
  constructor(message = "Pike binary not available") {
    super(message);
    this.constructor = PikeUnavailableError;
    Object.setPrototypeOf(this, PikeUnavailableError.prototype);
  }
}

// ---------------------------------------------------------------------------
// FIFO queue item
// ---------------------------------------------------------------------------

interface QueueItem {
  payload: string;
  resolve: (response: PikeResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  token?: CancellationToken;
  /** Priority: lower number = higher priority. Default 0 (highest). */
  priority: number;
}

/** Priority constants for PikeWorker requests.
 *  Lower number = higher priority. Interactive requests (hover, completion)
 *  should be serviced before background work (diagnostics). */
export const PikePriority = {
  /** Interactive: typeof_, autodoc for hover/completion. */
  interactive: 0,
  /** Default: general requests. */
  normal: 1,
  /** Background: diagnostics, indexing. */
  background: 2,
} as const;
// ---------------------------------------------------------------------------
// PikeWorker class
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
      // ignore
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
      // ignore
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

export class PikeWorker {

  private proc: ChildProcess | null = null;
  private requestId = 0;
  private pending = new Map<number, {
    resolve: (response: PikeResponse) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private buffer = "";
  private restarting = false;
  private consecutiveMalformed = 0;
  private static readonly MALFORMED_RESTART_THRESHOLD = 5;
  private readonly config: PikeWorkerConfig;

  // Priority queue — ensures exactly one write to stdin at a time.
  // Items with lower priority number are sent first.
  private readonly queue: QueueItem[] = [];
  private sending = false;

  // Idle eviction
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRequestTime = 0;

  // Memory ceiling tracking
  private requestCount = 0;
  private startTime = 0;

  /**
   * Tracks Pike binary availability:
   * - null = unknown (not yet attempted)
   * - true = available (spawn succeeded)
   * - false = unavailable (exit code 127 or pike not found)
   */
  private pikeAvailable: boolean | null = null;

  /**
   * Callback for critical errors that should be routed through the centralized
   * error log. Set by the server after construction via `setErrorHandler`.
   * Signature: (ctx: string, err: unknown) => void.
   */
  private onCriticalError: ((ctx: string, err: unknown) => void) | null = null;

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
    this.proc = spawn(finalCmd, finalArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
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
      // Suppress stderr logging once Pike is known to be unavailable.
      // The first occurrence (the "nice: pike: No such file" spam) is
      // unavoidable since pikeAvailable is null at spawn time.
      if (msg && this.pikeAvailable !== false) {
        this.onCriticalError?.("worker.stderr", new Error(`[pike-worker stderr] ${msg}`));
      }
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
        for (const item of this.queue) {
          clearTimeout(item.timeout);
          item.reject(error);
        }
        this.queue.length = 0;
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
    this.queue.length = 0;
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
  // FIFO-queued request — all public methods go through this
  // -----------------------------------------------------------------------

  /**
   * Enqueue a request.  The queue guarantees that at most one request is
   * written to stdin at any time.  Returns a promise that resolves with
   * the Pike worker's response.
   */

  private enqueue(method: string, params: Record<string, unknown> = {}, token?: CancellationToken, priority: number = PikePriority.normal): Promise<PikeResponse> {
    // Fast path: if Pike is known to be unavailable, reject immediately.
    // This avoids spamming stderr with "nice: pike: No such file" on every request.
    if (this.pikeAvailable === false) {
      return Promise.reject(new PikeUnavailableError());
    }

    // Check if forced restart is needed before queuing
    if (this.shouldForceRestart()) {
      this.restarting = true;
      try {
        this.stop();
        this.start();
      } catch {
        // stop() may throw if worker is already dead — ensure we still start
        this.start();
      }
      this.restarting = false;
    }

    this.start(); // Lazy start (no-op if already running)

    const id = ++this.requestId;
    this.requestCount++;
    const request: PikeRequest = { id, method, params };
    const payload = JSON.stringify(request) + "\n";

    // Reset idle timer
    this.resetIdleTimer();
    this.lastRequestTime = Date.now();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        // Remove from pending map (may already be resolved)
        this.pending.delete(id);
        // Also remove from queue if not yet sent
        const queueIdx = this.queue.findIndex(item =>
          item.payload === payload
        );
        if (queueIdx !== -1) {
          this.queue.splice(queueIdx, 1);
        }
        reject(new Error(`TIMEOUT: Pike worker timeout for ${method} (id=${id})`));
      }, this.config.requestTimeoutMs);

      const item: QueueItem = {
        payload,
        resolve: (response: PikeResponse) => {
          clearTimeout(timeout);
          resolve(response);
        },
        reject: (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        },
        timeout,
        token,
        priority,
      };

      // Register in pending map so processBuffer can resolve it
      this.pending.set(id, {
        resolve: item.resolve,
        reject: item.reject,
        timeout: item.timeout,
      });

      this.queue.push(item);
      this.drainQueue();
    });
  }

  /**
   * Drain the priority queue.  Sends exactly one item at a time.
   * Handles stdin backpressure by waiting for the drain event.
   * Picks the item with the lowest priority number (highest priority) first.
   */
  private drainQueue(): void {
    if (this.sending || this.queue.length === 0) return;
    if (!this.proc || this.proc.killed) return;

    // Find the highest-priority item (lowest number).
    let bestIdx = 0;
    for (let i = 1; i < this.queue.length; i++) {
      if (this.queue[i].priority < this.queue[bestIdx].priority) {
        bestIdx = i;
      }
    }

    this.sending = true;
    const item = this.queue[bestIdx];
    // Remove the item by swapping with last and popping (O(1) instead of splice O(n)).
    // Order within the same priority level is preserved because we scan left-to-right
    // and only swap when strictly lower priority number.
    this.queue[bestIdx] = this.queue[this.queue.length - 1];
    this.queue.pop();

    // Check cancellation before writing to subprocess
    if (item.token?.isCancellationRequested) {
      const parsed: { id: number } = JSON.parse(item.payload);
      const pending = this.pending.get(parsed.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(parsed.id);
      }
      item.resolve({ id: parsed.id, error: { code: -32800, message: "Request cancelled" } });
      this.sending = false;
      this.drainQueue();
      return;
    }

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
  }

  /**
   * Write a payload to stdin, respecting backpressure.
   * If the write returns false (buffer full), wait for the drain event.
   */
  private writeToStdin(payload: string): Promise<void> {
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

  // -----------------------------------------------------------------------
  // Public API — all delegate to enqueue()
  // -----------------------------------------------------------------------

  /** Diagnose a source file. */
  async diagnose(
    source: string,
    filepath: string,
    options?: {
      strict?: boolean;
      modulePaths?: string[];
      includePaths?: string[];
      programPaths?: string[];
    },
    token?: CancellationToken,
  ): Promise<DiagnoseResult> {
    try {
      const response = await this.enqueue("diagnose", {
        source,
        file: filepath,
        strict: options?.strict ?? false,
        module_paths: options?.modulePaths ?? [],
        include_paths: options?.includePaths ?? [],
        program_paths: options?.programPaths ?? [],
      }, token, PikePriority.background);

      if (response.error) {
        throw new Error(`Pike diagnose failed: ${response.error.message}`);
      }

      return response.result as unknown as DiagnoseResult;
    } catch (err) {
      // Check if this was a timeout — surface as a special result
      if ((err as Error).message?.startsWith("TIMEOUT:")) {
        return {
          diagnostics: [],
          exit_code: 1,
          timedOut: true,
        };
      }
      throw err;
    }
  }

  /** Extract AutoDoc XML from Pike source. */
  async autodoc(source: string, file?: string, token?: CancellationToken): Promise<AutodocResult> {
    const response = await this.enqueue("autodoc", {
      source,
      file: file ?? "<autodoc>",
    }, token, PikePriority.interactive);

    if (response.error) {
      return { xml: "", error: response.error.message };
    }

    return response.result as unknown as AutodocResult;
  }

  /** Get the type of an expression in context. */
  async typeof_(source: string, expression: string, token?: CancellationToken): Promise<TypeofResult> {
    const response = await this.enqueue("typeof", {
      source,
      expression,
    }, token, PikePriority.interactive);

    if (response.error) {
      return { type: "mixed", error: response.error.message };
    }

    return response.result as unknown as TypeofResult;
  }


  /** Resolve a symbol to its kind, source location, and inheritance chain. */
  async resolve(symbol: string, token?: CancellationToken): Promise<ResolveResult> {
    try {
      const response = await this.enqueue("resolve", { symbol }, token, PikePriority.interactive);
      if (response.error) {
        return { resolved: false, error: response.error.message };
      }
      return response.result as unknown as ResolveResult;
    } catch (err) {
      if ((err as Error).message?.startsWith("TIMEOUT:")) {
        return { resolved: false, error: "Timeout" };
      }
      throw err;
    }
  }

  /** Health check. */
  async ping(): Promise<{ status: string; pike_version: string }> {
    const response = await this.enqueue("ping");
    if (response.error) {
      throw new Error(`Pike ping failed: ${response.error.message}`);
    }
    return response.result as { status: string; pike_version: string };
  }

  /** Restart the worker (after crash, idle eviction, or memory ceiling). */
  async restart(): Promise<void> {
    this.restarting = true;

    // Clear all pending request timeouts to prevent spurious fires
    // after the new process is up.
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout);
    }
    this.pending.clear();

    this.stop();
    this.start();
    this.restarting = false;

    // Retry loop: up to 3 ping attempts with increasing backoff
    const delays = [100, 200, 300];
    for (const delay of delays) {
      await new Promise((r) => setTimeout(r, delay));
      try {
        await this.ping();
        return;
      } catch {
        // Continue to next attempt
      }
    }

    const message = 'Pike worker failed to restart after 3 ping attempts';
    this.onCriticalError?.('worker.restart', new Error(message));
    throw new Error(message);
  }

  // ---------------------------------------------------------------------------
  // Idle eviction
  // ---------------------------------------------------------------------------

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (this.proc && !this.proc.killed && this.pending.size === 0) {
        this.proc.kill("SIGTERM");
        this.proc = null;
      }
    }, this.config.idleTimeoutMs);
    // Don't prevent process exit
    if (this.idleTimer.unref) {
      this.idleTimer.unref();
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Memory ceiling check
  // ---------------------------------------------------------------------------

  private shouldForceRestart(): boolean {
    if (!this.proc || this.proc.killed) return false;

    // Request count ceiling
    if (this.requestCount >= this.config.maxRequestsBeforeRestart) {
      return true;
    }

    // Active time ceiling
    if (this.startTime > 0) {
      const activeMinutes = (Date.now() - this.startTime) / 60_000;
      if (activeMinutes >= this.config.maxActiveMinutes) {
        return true;
      }
    }

    return false;
  }

  // ---------------------------------------------------------------------------
  // Internal: response parsing
  // ---------------------------------------------------------------------------

  private processBuffer(): void {
    while (true) {
      const newlineIdx = this.buffer.indexOf("\n");
      if (newlineIdx === -1) break;

      const line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (!line.trim()) continue;

      try {
        const response: PikeResponse = JSON.parse(line);
        this.consecutiveMalformed = 0;
        const pending = this.pending.get(response.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(response.id);
          pending.resolve(response);
        } else {
          // Response arrived after timeout — log and discard
          console.debug(`[pike-worker] Discarding response for timed-out request id=${response.id}`);
        }
      } catch {
        // Malformed response — could be debug output or protocol corruption.
        // Count consecutive failures and restart if threshold exceeded.
        this.consecutiveMalformed++;
        this.onCriticalError?.(
          "worker.malformedResponse",
          new Error(`Malformed response (${this.consecutiveMalformed}/${PikeWorker.MALFORMED_RESTART_THRESHOLD}): ${line.slice(0, 200)}`),
        );
        if (this.consecutiveMalformed >= PikeWorker.MALFORMED_RESTART_THRESHOLD) {
          this.onCriticalError?.("worker.malformedThreshold", new Error("Too many malformed responses"));
          this.consecutiveMalformed = 0;
          this.restart().catch((err) => {
            this.onCriticalError?.('worker.autoRestart', err);
          });
        }
      }
    }
  }
}
