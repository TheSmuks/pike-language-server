/**
 * The Pike worker subprocess: starting it, writing to it, and deciding what a
 * failure to start means.
 *
 * Spawning is kept out of PikeWorkerProcess because the two runtimes disagree:
 * Bun throws from `spawn()` where Node reports the same failure asynchronously
 * on the child's `error` event. Both paths end up here, so the class has one
 * way to fail rather than two.
 */

import { spawn, type ChildProcess } from "node:child_process";

export interface SpawnAttempt {
  proc?: ChildProcess;
  error?: unknown;
}

/** Spawn the worker, reporting a synchronous failure instead of throwing. */
export function trySpawnWorker(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): SpawnAttempt {
  try {
    return { proc: spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], cwd, env }) };
  } catch (error) {
    return { error };
  }
}

/**
 * Write a payload to the worker's stdin, respecting backpressure.
 * If the write returns false (buffer full), wait for the drain event.
 */
export function writeToWorkerStdin(
  proc: ChildProcess | null,
  payload: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!proc || proc.killed || !proc.stdin) {
      reject(new Error("Pike worker process not available"));
      return;
    }
    const stdin = proc.stdin;
    if (stdin.write(payload)) {
      resolve();
      return;
    }
    const onDrain = () => { cleanup(); resolve(); };
    const onError = (err: Error) => { cleanup(); reject(err); };
    const cleanup = () => {
      stdin.removeListener("drain", onDrain);
      stdin.removeListener("error", onError);
    };
    stdin.once("drain", onDrain);
    stdin.once("error", onError);
  });
}

/**
 * Whether a spawn failure means Pike is out of reach for good.
 *
 * A missing or unexecutable binary is a dead end and the server should degrade
 * to tree-sitter for the session. EAGAIN or EMFILE under memory pressure is
 * not — latching those would silently disable Pike until the editor restarts.
 * An error with no errno is treated as permanent: unknown means unrecoverable.
 */
export function isPermanentSpawnFailure(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (!code) return true;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "ENOTDIR";
}
