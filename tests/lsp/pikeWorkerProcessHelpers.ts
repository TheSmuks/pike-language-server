/**
 * Test helpers for Pike worker process lifecycle tests.
 *
 * Provides utilities for:
 * - Spawning a Pike worker with controlled behavior
 * - Simulating timeouts and crashes
 * - Asserting process termination and cleanup
 * - Testing heartbeat/watchdog interactions
 *
 * These helpers are designed to work with both in-process tests (PassThrough)
 * and direct PikeWorker instantiation.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestWorkerOptions {
  /** Path to the Pike executable. Defaults to "pike". */
  pikeBin?: string;
  /** Path to harness/worker.pike. */
  workerScript?: string;
  /** Heartbeat interval in ms (passed to worker via env). */
  heartbeatIntervalMs?: number;
  /** Watchdog timeout in ms (passed to worker via env). */
  watchdogTimeoutMs?: number;
  /** If true, the worker will exit immediately (for crash simulation). */
  crashOnStart?: boolean;
  /** If true, the worker will hang indefinitely (for timeout simulation). */
  hangForever?: boolean;
}

export interface SpawnedTestWorker {
  process: ChildProcess;
  pid: number;
  /** Kill the process and wait for exit. */
  kill(): Promise<void>;
  /** Whether the process is still alive. */
  isAlive(): boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PIKE_BIN = "pike";
const DEFAULT_WORKER_SCRIPT = join(process.cwd(), "harness", "worker.pike");

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether the Pike executable is available.
 */
export function isPikeAvailable(): boolean {
  const bin = process.env.PIKE_BIN ?? DEFAULT_PIKE_BIN;
  try {
    const result = spawn(bin, ["--version"], { stdio: "ignore" });
    return result.pid !== undefined;
  } catch {
    return false;
  }
}

/**
 * Spawn a Pike worker process with controlled options for testing.
 *
 * The worker is spawned with environment variables that control behavior:
 * - PIKE_LSP_TEST_CRASH: exit immediately
 * - PIKE_LSP_TEST_HANG: never respond to requests
 * - PIKE_LSP_HEARTBEAT_INTERVAL_MS: heartbeat send rate
 * - PIKE_LSP_WATCHDOG_TIMEOUT_MS: self-termination deadline
 */
export function spawnTestWorker(options: TestWorkerOptions = {}): SpawnedTestWorker {
  const pikeBin = options.pikeBin ?? process.env.PIKE_BIN ?? DEFAULT_PIKE_BIN;
  const workerScript = options.workerScript ?? DEFAULT_WORKER_SCRIPT;

  if (!existsSync(workerScript)) {
    throw new Error(`Worker script not found: ${workerScript}`);
  }

  const env: Record<string, string> = {
    ...process.env,
    ...(options.heartbeatIntervalMs !== undefined && {
      PIKE_LSP_HEARTBEAT_INTERVAL_MS: String(options.heartbeatIntervalMs),
    }),
    ...(options.watchdogTimeoutMs !== undefined && {
      PIKE_LSP_WATCHDOG_TIMEOUT_MS: String(options.watchdogTimeoutMs),
    }),
    ...(options.crashOnStart && { PIKE_LSP_TEST_CRASH: "1" }),
    ...(options.hangForever && { PIKE_LSP_TEST_HANG: "1" }),
  };

  const child = spawn(pikeBin, [workerScript], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });

  return {
    process: child,
    pid: child.pid!,
    async kill(): Promise<void> {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGTERM");
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 2_000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
    isAlive(): boolean {
      return child.exitCode === null && !child.killed;
    },
  };
}

/**
 * Wait for a process to exit, with a timeout.
 * Returns the exit code, or null if the process did not exit in time.
 */
export async function waitForExit(
  worker: SpawnedTestWorker,
  timeoutMs = 5_000,
): Promise<number | null> {
  if (!worker.isAlive()) return worker.process.exitCode;

  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    worker.process.once("exit", (code: number | null) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/**
 * Assert that a child process has exited within a deadline.
 */
export async function assertExited(
  worker: SpawnedTestWorker,
  timeoutMs = 5_000,
  context = "",
): Promise<number> {
  const code = await waitForExit(worker, timeoutMs);
  if (code === null) {
    throw new Error(
      `Process did not exit within ${timeoutMs}ms${context ? ` (${context})` : ""}`,
    );
  }
  return code;
}
