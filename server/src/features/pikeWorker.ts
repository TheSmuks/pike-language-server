/**
 * PikeWorker: manages a long-lived Pike subprocess for diagnostics and type queries.
 *
 * Architecture (decision 0011):
 * - One Pike process, kept alive across requests
 * - Communication over stdio using JSON protocol
 * - Automatic restart on crash
 * - Lazy start (on first request)
 * - Content-hash caching (via caller)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

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

  /** Start the Pike worker process (lazy — called on first request). */
  start(): void {
    if (this.proc && !this.proc.killed) return;

    this.proc = spawn("pike", [WORKER_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: PROJECT_ROOT,
    });

    this.proc.stdout!.on("data", (data: Buffer) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    this.proc.stderr!.on("data", (data: Buffer) => {
      // Log Pike worker stderr (compilation errors, runtime warnings)
      const msg = data.toString().trim();
      if (msg) {
        console.error("[pike-worker stderr]", msg);
      }
    });

    this.proc.on("exit", (code, signal) => {
      if (!this.restarting) {
        // Unexpected exit — reject all pending requests
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
  }

  /** Stop the Pike worker process. */
  stop(): void {
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
  }

  /** Check if the worker is alive. */
  get isAlive(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  /** Send a request and wait for the response. */
  async request(method: string, params: Record<string, unknown> = {}): Promise<PikeResponse> {
    this.start(); // Lazy start

    const id = ++this.requestId;
    const request: PikeRequest = { id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pike worker timeout for ${method} (id=${id})`));
      }, 10_000);

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

  /** Restart the worker (after crash or error). */
  async restart(): Promise<void> {
    this.restarting = true;
    this.stop();
    this.start();
    this.restarting = false;

    // Give the process a moment to initialize before pinging
    await new Promise((r) => setTimeout(r, 100));

    // Wait for the worker to be ready
    try {
      await this.ping();
    } catch {
      throw new Error("Pike worker failed to restart");
    }
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
