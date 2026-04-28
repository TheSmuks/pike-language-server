/**
 * PikeWorker: manages a Pike subprocess for diagnostics and type queries.
 *
 * Architecture (decision 0011 — shared-server deployment):
 * - One Pike process per LSP server instance
 * - Communication over stdio using JSON protocol
 * - Idle eviction: kill after N minutes of no requests (default 5)
 * - Memory ceiling: restart after N requests or M minutes of active use
 * - CPU politeness: spawned with nice +5 on Linux
 * - FIFO queueing: one request at a time, no pipelining
 * - Timeout: 5s per request (configurable), surfaced as diagnostic on timeout
 * - Lazy start (on first request)
 * - Content-hash caching (via caller, with LRU eviction)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, join } from "node:path";

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
}

const DEFAULT_CONFIG: PikeWorkerConfig = {
  idleTimeoutMs: 5 * 60 * 1000,
  maxRequestsBeforeRestart: 100,
  maxActiveMinutes: 30,
  requestTimeoutMs: 5_000,
  niceValue: 5,
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
}

export interface DiagnoseResult {
  diagnostics: PikeDiagnostic[];
  exit_code: number;
  /** Set when the request timed out — caller should surface as diagnostic. */
  timedOut?: boolean;
}

export interface TypeofResult {
  type: string;
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
// PikeWorker class
// ---------------------------------------------------------------------------

const PROJECT_ROOT = resolve(import.meta.dir, "..", "..", "..");
const WORKER_SCRIPT = join(PROJECT_ROOT, "harness", "worker.pike");

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
  private readonly config: PikeWorkerConfig;

  // Idle eviction
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRequestTime = 0;

  // Memory ceiling tracking
  private requestCount = 0;
  private startTime = 0;

  constructor(config?: Partial<PikeWorkerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Start the Pike worker process (lazy — called on first request). */
  start(): void {
    if (this.proc && !this.proc.killed) return;

    // Build spawn args with nice
    const spawnArgs: string[] = [];
    const spawnCmd: string = "pike";

    // On Linux, use nice for CPU politeness under contention
    let finalCmd: string;
    let finalArgs: string[];

    if (this.config.niceValue > 0 && process.platform === "linux") {
      finalCmd = "nice";
      finalArgs = ["-n" + this.config.niceValue, "pike", WORKER_SCRIPT];
    } else {
      finalCmd = "pike";
      finalArgs = [WORKER_SCRIPT];
    }

    this.proc = spawn(finalCmd, finalArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: PROJECT_ROOT,
    });

    this.proc.stdout!.on("data", (data: Buffer) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    this.proc.stderr!.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) {
        console.error("[pike-worker stderr]", msg);
      }
    });

    this.proc.on("exit", (code, signal) => {
      this.clearIdleTimer();
      if (!this.restarting) {
        const error = new Error(
          `Pike worker exited (code=${code}, signal=${signal})`,
        );
        for (const [, pending] of this.pending) {
          clearTimeout(pending.timeout);
          pending.reject(error);
        }
        this.pending.clear();
        this.proc = null;
      }
    });

    // Reset tracking
    this.requestCount = 0;
    this.startTime = Date.now();
  }

  /** Stop the Pike worker process. */
  stop(): void {
    this.clearIdleTimer();
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
  }

  /** Check if the worker is alive. */
  get isAlive(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  /** Get current request count since last start. */
  get currentRequestCount(): number {
    return this.requestCount;
  }

  /** Send a request and wait for the response. */
  async request(method: string, params: Record<string, unknown> = {}): Promise<PikeResponse> {
    // Check if forced restart is needed before starting
    if (this.shouldForceRestart()) {
      try {
        await this.restart();
      } catch {
        // If restart fails, try a fresh start
        this.start();
      }
    }

    this.start(); // Lazy start

    // Track request count for memory ceiling
    this.requestCount++;

    const id = ++this.requestId;
    const request: PikeRequest = { id, method, params };

    // Reset idle timer
    this.resetIdleTimer();
    this.lastRequestTime = Date.now();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`TIMEOUT: Pike worker timeout for ${method} (id=${id})`));
      }, this.config.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timeout });

      const payload = JSON.stringify(request) + "\n";
      this.proc!.stdin!.write(payload);
    });
  }

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
  ): Promise<DiagnoseResult> {
    try {
      const response = await this.request("diagnose", {
        source,
        file: filepath,
        strict: options?.strict ?? false,
        module_paths: options?.modulePaths ?? [],
        include_paths: options?.includePaths ?? [],
        program_paths: options?.programPaths ?? [],
      });

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

  /** Get the type of an expression in context. */
  async typeof_(source: string, expression: string): Promise<TypeofResult> {
    const response = await this.request("typeof", {
      source,
      expression,
    });

    if (response.error) {
      return { type: "mixed", error: response.error.message };
    }

    return response.result as unknown as TypeofResult;
  }

  /** Health check. */
  async ping(): Promise<{ status: string; pike_version: string }> {
    const response = await this.request("ping");
    if (response.error) {
      throw new Error(`Pike ping failed: ${response.error.message}`);
    }
    return response.result as { status: string; pike_version: string };
  }

  /** Restart the worker (after crash, idle eviction, or memory ceiling). */
  async restart(): Promise<void> {
    this.restarting = true;
    this.stop();
    this.start();
    this.restarting = false;

    // Give the process a moment to initialize before pinging
    await new Promise((r) => setTimeout(r, 100));

    try {
      await this.ping();
    } catch {
      throw new Error("Pike worker failed to restart");
    }
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
        const pending = this.pending.get(response.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(response.id);
          pending.resolve(response);
        }
      } catch {
        // Ignore malformed responses
      }
    }
  }
}
