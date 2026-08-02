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
import { LRUCache } from "../util/lruCache.js";
import { hashContent } from "./cacheHash.js";
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
  // Interactive-query result caches
  //
  // typeof_ and resolve recompile the entire source (via compile_string) on
  // every call, so hovering the same variable twice pays the full cost twice.
  // These bounded LRU caches memoize successful results so repeated hovers /
  // completions on unchanged content hit memory instead of the Pike worker.
  //
  // Keys: typeof is keyed by hash(source)+expression (source-dependent);
  // resolve is keyed by symbol (workspace-global). Only successful results are
  // cached — errors and unresolved symbols may change once module paths are
  // added, so caching them would return stale negatives. Both caches are
  // cleared on stop()/restart() because the worker resets its module-path
  // state, which can change what resolves.
  // -----------------------------------------------------------------------

  private readonly typeofCache = new LRUCache<TypeofResult>({
    maxEntries: 512,
    maxBytes: 2 * 1024 * 1024,
    estimateSize: (v) => (v.type?.length ?? 0) + 32,
  });

  private readonly resolveCache = new LRUCache<ResolveResult>({
    maxEntries: 512,
    maxBytes: 8 * 1024 * 1024,
    estimateSize: (v) => JSON.stringify(v).length,
  });

  /**
   * Clear interactive-query caches. Called whenever the worker stops so a
   * fresh process (with reset module-path state) never serves stale results.
   */
  override stop(): void {
    super.stop();
    this.typeofCache.clear();
    this.resolveCache.clear();
  }

  // -----------------------------------------------------------------------
  // FIFO-queued request — all public methods go through this
  // -----------------------------------------------------------------------

  /**
   * Enqueue a request.  The queue guarantees that at most one request is
   * written to stdin at any time.  Returns a promise that resolves with
   * the Pike worker's response.
   */

  private checkBackoff(): boolean {
    return this.health.checkAndClearBackoff();
  }

  private prepareRestart(): void {
    if (this.shouldForceRestart()) {
      this.restarting = true;
      try {
        this.stop();
        this.start();
      } catch {
        this.start();
      }
      this.restarting = false;
    }
  }

  private enqueue(method: string, params: Record<string, unknown> = {}, token?: CancellationToken, priority: number = PikePriority.normal): Promise<PikeResponse> {
    if (this.pikeAvailable === false) {
      return Promise.reject(new PikeUnavailableError());
    }
    if (!this.checkBackoff()) {
      return Promise.reject(
        new Error(`Pike worker is in crash-loop backoff until ${new Date(this.health.backoffUntilMs).toISOString()}`),
      );
    }

    this.prepareRestart();
    this.start();

    const id = ++this.requestId;
    this.requestCount++;
    const request: PikeRequest = { id, method, params };
    const payload = JSON.stringify(request) + "\n";

    this.resetIdleTimer();
    this.lastRequestTime = Date.now();

    return this.enqueuePromise(id, payload, priority, token);
  }

  private enqueuePromise(id: number, payload: string, priority: number, token?: CancellationToken): Promise<PikeResponse> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        for (const q of this.queues) {
          const queueIdx = q.findIndex(item => item.payload === payload);
          if (queueIdx !== -1) { q.splice(queueIdx, 1); break; }
        }
        // Force-kill the unresponsive process so the next request starts fresh.
        // Without this, a hung Pike process blocks all subsequent requests.
        this.forceKillForTimeout(id);
        reject(new Error(`TIMEOUT: Pike worker timeout for id=${id}`));
      }, this.config.requestTimeoutMs);

      const item = { payload, resolve, reject, timeout, token, priority };
      this.pending.set(id, { resolve: item.resolve, reject: item.reject, timeout: item.timeout });
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
      /** Workspace dependency files, leaf-first; the worker evicts its module
       *  caches for each and compiles `source` overlays in place of disk. */
      dependencies?: Array<{ file: string; source?: string }>;
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
        dependencies: options?.dependencies ?? [],
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
    const cacheKey = hashContent(source) + "\0" + expression;
    const cached = this.typeofCache.get(cacheKey);
    if (cached) return cached;

    const response = await this.enqueue("typeof", {
      source,
      expression,
    }, token, PikePriority.interactive);

    if (response.error) {
      return { type: "mixed", error: response.error.message };
    }

    const result = validateTypeofResult(response.result);
    // Only cache successful evaluations — an error may resolve on retry.
    if (!result.error) this.typeofCache.set(cacheKey, result);
    return result;
  }


  /** Resolve a symbol to its kind, source location, and inheritance chain. */
  async resolve(symbol: string, token?: CancellationToken): Promise<ResolveResult> {
    const cached = this.resolveCache.get(symbol);
    if (cached) return cached;

    try {
      const response = await this.enqueue("resolve", { symbol }, token, PikePriority.interactive);
      if (response.error) {
        return { resolved: false, error: response.error.message };
      }
      const result = validateResolveResult(response.result);
      // Only cache positive resolutions — a symbol that does not resolve yet
      // may resolve later once a diagnose adds its module path to the worker.
      if (result.resolved) this.resolveCache.set(symbol, result);
      return result;
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

    // Reject every in-flight request: the process that would have answered
    // them is going away, so their promises can never resolve. Previously we
    // cleared their timeouts and dropped them from the map, which left the
    // awaiting callers hanging forever (their timeout was the only thing that
    // could have rejected them). Rejecting keeps success distinguishable from
    // failure — callers fall back to degraded results instead of stalling.
    this.rejectAllPending(new Error("Pike worker restarting — in-flight request aborted"));

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
