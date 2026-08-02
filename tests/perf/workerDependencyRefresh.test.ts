/**
 * A diagnose must not re-read the workspace directory once per dependency.
 *
 * The worker evicts the master's module caches for every dependency of the
 * file it compiles, and part of that eviction rebuilds the directory node so a
 * module created or deleted since the last diagnose is seen. Rebuilding a
 * module-path entry re-reads the *whole* directory, so doing it per dependency
 * costs (dependencies x directory entries) on every keystroke: on a workspace
 * root of 5,000 files a twenty-dependency file measured 128 ms per diagnose
 * against 7 ms for a one-dependency file — and the cross-file propagation then
 * charges the same to every open dependent.
 *
 * The assertion is a ratio, not a wall-clock budget, so it means the same
 * thing on a fast machine and a loaded CI runner: the cost of a diagnose must
 * stay flat in the number of dependencies that share a directory.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PikeWorker } from "../../server/src/features/pikeWorker";

const DIRECTORY_ENTRIES = 3_000;
const MANY_DEPENDENCIES = 20;
const ITERATIONS = 7;

let root: string | null = null;

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function buildWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "pike-dep-refresh-"));
  for (let i = 0; i < DIRECTORY_ENTRIES; i++) {
    writeFileSync(join(dir, `filler${i}.pmod`), `int f() { return ${i}; }\n`, "utf8");
  }
  for (let i = 0; i < MANY_DEPENDENCIES; i++) {
    writeFileSync(join(dir, `dep${i}.pmod`), `int helper(int x) { return x + ${i}; }\n`, "utf8");
  }
  return dir;
}

function sourceUsing(count: number, tag: number): string {
  const calls = Array.from({ length: count }, (_, i) => `dep${i}.helper(${i})`).join(" + ");
  return `import ".";\nint go${tag}() { return ${calls}; }\n`;
}

async function medianDiagnoseMs(
  worker: PikeWorker,
  dir: string,
  count: number,
): Promise<number> {
  const dependencies = Array.from({ length: count }, (_, i) => ({
    file: join(dir, `dep${i}.pmod`),
  }));
  const times: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const started = performance.now();
    const result = await worker.diagnose(
      sourceUsing(count, i), join(dir, "main.pike"),
      { modulePaths: [dir], dependencies },
    );
    times.push(performance.now() - started);
    // A compile error would mean the imports never resolved and the timing
    // measures nothing.
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  }
  return times.sort((a, b) => a - b)[Math.floor(times.length / 2)]!;
}

describe("worker dependency refresh", () => {
  test("diagnose cost stays flat in dependencies sharing a directory", async () => {
    root = buildWorkspace();
    const worker = new PikeWorker();
    try {
      // Warm: the first diagnose pays for resolving the module path itself.
      await medianDiagnoseMs(worker, root, 1);
      const one = await medianDiagnoseMs(worker, root, 1);
      const many = await medianDiagnoseMs(worker, root, MANY_DEPENDENCIES);
      console.log(
        `[dep-refresh] ${DIRECTORY_ENTRIES} files: 1 dep ${one.toFixed(1)}ms, ` +
        `${MANY_DEPENDENCIES} deps ${many.toFixed(1)}ms (ratio ${(many / one).toFixed(2)})`,
      );
      // Per-dependency rebuilding put this at ~MANY_DEPENDENCIES. Compiling the
      // extra dependencies' overlays is real work, so allow generous slack.
      expect(many / one).toBeLessThan(4);
    } finally {
      worker.stop();
    }
  }, 180_000);
});
