/**
 * Shared test helpers for resource-resilience LSP tests.
 *
 * Extends the in-process test server (createTestServer) with utilities for:
 * - Configuring resource settings via initialization options
 * - Simulating memory pressure and degraded state
 * - Advancing fake clocks for hibernation tests
 * - Intercepting pike/resourceState notifications
 * - Asserting no orphan Pike processes after teardown
 */

import type { MessageConnection } from "vscode-jsonrpc";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResourceTestConfig {
  /** Indexing mode: "openFiles" | "full" | "auto". */
  indexingMode?: string;
  /** Max heap in MB before degraded mode. */
  memoryBudgetMb?: number;
  /** Pike request timeout in ms. */
  workerTimeoutMs?: number;
  /** Idle hibernation threshold in ms. */
  hibernationIdleMs?: number;
  /** Ignore glob patterns for background indexing. */
  indexIgnoreGlobs?: string[];
  /** Max file size in bytes for indexing. */
  indexMaxFileSizeBytes?: number;
}

export interface ResourceStateCapture {
  states: string[];
  latest: unknown | null;
}

// ---------------------------------------------------------------------------
// Resource configuration
// ---------------------------------------------------------------------------

/**
 * Build LSP initialization options carrying resource-resilience settings.
 * These flow through onInitialize → serverInitHandler → resourceConfiguration.
 */
export function buildResourceInitOptions(config: ResourceTestConfig): Record<string, unknown> {
  return {
    pike: {
      languageServer: {
        indexing: {
          mode: config.indexingMode ?? "openFiles",
          ignoreGlobs: config.indexIgnoreGlobs ?? [],
          maxFileSizeBytes: config.indexMaxFileSizeBytes ?? 1_048_576,
        },
        memory: {
          budgetMb: config.memoryBudgetMb ?? 512,
        },
        worker: {
          requestTimeoutMs: config.workerTimeoutMs ?? 30_000,
        },
        hibernation: {
          idleThresholdMs: config.hibernationIdleMs ?? 600_000,
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Resource state notification capture
// ---------------------------------------------------------------------------

/**
 * Attach a handler to capture pike/resourceState notifications.
 * Returns an object that accumulates states for later assertion.
 */
export function captureResourceStates(client: MessageConnection): ResourceStateCapture {
  const capture: ResourceStateCapture = {
    states: [],
    latest: null,
  };

  client.onNotification("pike/resourceState", (payload: unknown) => {
    const state = (payload as { state?: string })?.state ?? "unknown";
    capture.states.push(state);
    capture.latest = payload;
  });

  return capture;
}

/**
 * Wait until a resource-state capture includes a given state, with a timeout.
 */
export async function waitForResourceState(
  capture: ResourceStateCapture,
  expectedState: string,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (capture.states.includes(expectedState)) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return capture.states.includes(expectedState);
}

// ---------------------------------------------------------------------------
// Fake clock (for hibernation tests)
// ---------------------------------------------------------------------------

/**
 * A controllable fake clock. Advances a counter that can be polled by
 * hibernation logic. The real timer subsystem is not modified — instead,
 * resource modules that support fake-clock injection should check
 * process.env.PIKE_LSP_FAKE_CLOCK_MS for the current time.
 */
export class FakeClock {
  private currentMs: number;

  constructor(startMs = Date.now()) {
    this.currentMs = startMs;
    process.env.PIKE_LSP_FAKE_CLOCK_MS = String(this.currentMs);
  }

  now(): number {
    return this.currentMs;
  }

  advance(deltaMs: number): void {
    this.currentMs += deltaMs;
    process.env.PIKE_LSP_FAKE_CLOCK_MS = String(this.currentMs);
  }

  dispose(): void {
    delete process.env.PIKE_LSP_FAKE_CLOCK_MS;
  }
}

// ---------------------------------------------------------------------------
// Process assertions
// ---------------------------------------------------------------------------

/**
 * Count Pike processes matching a pattern. Used to assert no orphan workers
 * survive after shutdown or hibernation.
 */
export function countPikeProcesses(): number {
  try {
    const output = execSync("pgrep -f 'harness/worker.pike' 2>/dev/null || true", {
      encoding: "utf-8",
      timeout: 5_000,
    });
    return output.trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

/**
 * Assert no Pike worker processes are running.
 * Throws if any are found.
 */
export function assertNoPikeProcesses(context = ""): void {
  const count = countPikeProcesses();
  if (count > 0) {
    throw new Error(
      `Expected zero Pike worker processes${context ? ` (${context})` : ""}, found ${count}`,
    );
  }
}
