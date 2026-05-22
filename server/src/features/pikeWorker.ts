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

import type {
  CancellationToken,
} from "vscode-languageserver/node";
import {
  validateDiagnoseResult,
  validateAutodocResult,
  validateTypeofResult,
  validateResolveResult,
  validatePingResult,
} from "../util/jsonValidation.js";
import { PikeWorkerProcess } from "./pikeWorkerProcess.js";
import type {
  PikeWorkerConfig,
  PikeResponse,
  PikeRequest,
  DiagnoseResult,
  AutodocResult,
  TypeofResult,
  ResolveResult,
} from "./pikeWorkerTypes.js";
import {
  PikeUnavailableError,
  PikePriority,
  clampPriority,
} from "./pikeWorkerTypes.js";

// Re-export all types and constants so existing imports continue to work
export type {
  PikeWorkerConfig,
  PikeDiagnostic,
  DiagnoseResult,
  AutodocResult,
  TypeofResult,
  ResolveResult,
  PikeRequest,
  PikeResponse,
  QueueItem,
} from "./pikeWorkerTypes.js";
export {
  DEFAULT_CONFIG,
  PikeUnavailableError,
  PikePriority,
  clampPriority,
} from "./pikeWorkerTypes.js";

// ---------------------------------------------------------------------------
// PikeWorker class
// ---------------------------------------------------------------------------

export class PikeWorker extends PikeWorkerProcess {

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

    // Crash-loop backoff: if Pike has been crashing repeatedly, reject
    // requests until the backoff period expires. This prevents infinite
    // restart loops when Pike hits an internal fatal error on a specific file.
    if (this.crashBackoffUntil > 0 && Date.now() < this.crashBackoffUntil) {
      return Promise.reject(
        new Error(`Pike worker is in crash-loop backoff until ${new Date(this.crashBackoffUntil).toISOString()}`),
      );
    }
    // Backoff expired — reset crash counter so a fresh start is possible.
    if (this.crashBackoffUntil > 0 && Date.now() >= this.crashBackoffUntil) {
      this.consecutiveCrashes = 0;
      this.crashBackoffUntil = 0;
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
        for (const q of this.queues) {
          const queueIdx = q.findIndex(item =>
            item.payload === payload
          );
          if (queueIdx !== -1) {
            q.splice(queueIdx, 1);
            break;
          }
        }
        reject(new Error(`TIMEOUT: Pike worker timeout for ${method} (id=${id})`));
      }, this.config.requestTimeoutMs);

      const item = {
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

      this.queues[clampPriority(item.priority)].push(item);
      this.drainQueue();
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

      return validateDiagnoseResult(response.result);
    } catch (err) {
      // Check if this was a timeout — surface as a special result
      if ((err as Error).message?.startsWith("TIMEOUT:")) {
        return {
          diagnostics: [],
          exit_code: 1,
          timedOut: true,
        };
      }
      // Crash-loop backoff — surface as a special result so the caller
      // can show a user-friendly diagnostic instead of logging an error.
      if ((err as Error).message?.includes("crash-loop backoff")) {
        return {
          diagnostics: [],
          exit_code: 1,
          timedOut: false,
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

    return validateAutodocResult(response.result);
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

    return validateTypeofResult(response.result);
  }


  /** Resolve a symbol to its kind, source location, and inheritance chain. */
  async resolve(symbol: string, token?: CancellationToken): Promise<ResolveResult> {
    try {
      const response = await this.enqueue("resolve", { symbol }, token, PikePriority.interactive);
      if (response.error) {
        return { resolved: false, error: response.error.message };
      }
      return validateResolveResult(response.result);
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
    return validatePingResult(response.result);
  }

  /**
   * Pre-warm the worker: spawn the Pike process and verify it responds.
   *
   * Call during initialization (before user interaction) so the first real
   * request doesn't pay the cold-start cost of process spawning.
   * No-op if the worker is already running.
   *
   * @returns true if the worker is ready, false if Pike is unavailable
   */
  async warmUp(): Promise<boolean> {
    try {
      this.start(); // Idempotent — no-op if already running
      const pong = await this.ping();
      this.pikeVersion = pong.pike_version ?? null;
      return true;
    } catch {
      // Pike may not be installed or the harness may be missing.
      // This is fine — features that need Pike will gracefully degrade.
      return false;
    }
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
}
