/**
 * Spawning the Pike worker must not be able to kill the server.
 *
 * `bun build --compile` bakes `__dirname` as a build-time constant, so every
 * path derived from it names the *build machine's* checkout once the binary is
 * copied anywhere else. The spawn cwd was one of those paths: `spawn()` with a
 * cwd that does not exist fails before the child starts, emitting `error`
 * rather than `exit`, and an unlistened `error` became an uncaughtException —
 * which serverLifecycle turns into process.exit(1). Every released binary died
 * ~3s into every session, on any machine but the one that built it.
 *
 * Two independent guards, because either alone leaves the crash reachable:
 * the cwd must exist at runtime, and a spawn failure must degrade like any
 * other worker failure.
 */

import { describe, test, expect } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSpawnCommand,
  resolveSpawnCwd,
} from "../../server/src/features/pikeWorkerPaths";
import { PikeWorker } from "../../server/src/features/pikeWorker";

const MISSING = join("/nonexistent-build-machine", "tank", "projects", "checkout");

describe("resolveSpawnCwd", () => {
  test("prefers the first candidate that exists", () => {
    expect(resolveSpawnCwd(MISSING, process.cwd(), tmpdir())).toBe(process.cwd());
  });

  test("falls back to a directory that exists when no candidate does", () => {
    const cwd = resolveSpawnCwd(MISSING, `${MISSING}-2`);
    expect(cwd).toBe(tmpdir());
    expect(existsSync(cwd)).toBe(true);
  });

  test("never returns a non-existent directory", () => {
    for (const candidates of [[], [MISSING], [MISSING, `${MISSING}-2`]]) {
      expect(existsSync(resolveSpawnCwd(...candidates))).toBe(true);
    }
  });
});

describe("buildSpawnCommand", () => {
  test("hands spawn a cwd that exists on this machine", () => {
    const { cwd } = buildSpawnCommand("pike", 0, undefined);
    expect(existsSync(cwd)).toBe(true);
  });
});

describe("spawn failure degrades instead of crashing the process", () => {
  test("a missing Pike binary rejects the in-flight request", async () => {
    // niceValue 0 keeps `nice` out of the way so the missing binary is what
    // fails; with `nice` the failure arrives as exit 127 instead.
    const worker = new PikeWorker({
      pikeBinaryPath: "/nonexistent/pike-binary",
      niceValue: 0,
      requestTimeoutMs: 10_000,
    });
    const errors: string[] = [];
    worker.setErrorHandler((ctx) => { errors.push(ctx); });

    // Rejects on the spawn failure, well inside requestTimeoutMs — a request
    // that only fails on timeout means the error event was never handled.
    const started = Date.now();
    await expect(worker.ping()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);

    expect(worker.isAlive).toBe(false);
    expect(worker.isAvailable).toBe(false);
    expect(errors).toContain("worker.spawnFailed");
    worker.stop();
  });

  // Bun throws from spawn(), Node reports the same failure asynchronously on
  // the child's `error` event — and the released npm/tarball/vsix artifacts all
  // run under Node. Drive that listener directly: under `bun test` nothing else
  // reaches it, so deleting it would otherwise go unnoticed.
  function emitSpawnError(worker: PikeWorker, code: string): Promise<unknown> {
    const pending = worker.ping();
    const proc = (worker as unknown as { proc: ChildProcess | null }).proc;
    if (!proc) throw new Error("worker did not start a process to emit on");
    proc.emit("error", Object.assign(new Error(`spawn ${code}`), { code }));
    return pending;
  }

  test("an async spawn error degrades the worker (Node's path)", async () => {
    // A binary that exists, so a process is really there to emit on; the error
    // is emitted in the same tick, before any exit event can arrive.
    const worker = new PikeWorker({ pikeBinaryPath: "/bin/cat", niceValue: 0, requestTimeoutMs: 10_000 });
    const errors: string[] = [];
    worker.setErrorHandler((ctx) => { errors.push(ctx); });

    await expect(emitSpawnError(worker, "ENOENT")).rejects.toThrow();
    expect(errors).toContain("worker.spawnFailed");
    expect(worker.isAvailable).toBe(false);
    expect(worker.isAlive).toBe(false);
    worker.stop();
  });

  test("a transient errno does not disable Pike for the session", async () => {
    // EAGAIN/EMFILE under memory pressure is not a missing binary: latching
    // pikeAvailable there would kill Pike until the editor restarts.
    const worker = new PikeWorker({ pikeBinaryPath: "/bin/cat", niceValue: 0, requestTimeoutMs: 10_000 });
    await expect(emitSpawnError(worker, "EAGAIN")).rejects.toThrow();
    expect(worker.isAvailable).toBe(true);
    worker.stop();
  });

  test("the process survives the failure", async () => {
    const worker = new PikeWorker({ pikeBinaryPath: "/nonexistent/pike-binary", niceValue: 0 });
    worker.start();
    // An unhandled `error` event would take the whole process down here.
    await new Promise((r) => setTimeout(r, 300));
    expect(worker.isAlive).toBe(false);
    worker.stop();
  });
});
