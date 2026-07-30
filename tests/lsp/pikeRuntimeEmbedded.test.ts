/**
 * The compiled single-file binary has to carry the Pike runtime with it.
 *
 * `bun build --compile` bakes `import.meta.url` to a path that only exists on
 * the build machine, so the on-disk lookups in pikeWorkerPaths silently
 * resolved to the *builder's* checkout. The binary appeared to work everywhere
 * it was tested and would have found nothing on a user's machine — the same
 * silent degradation as the standalone bundle, minus the visible missing
 * directory.
 *
 * These cover the fallback: when no on-disk layout matches but the binary
 * carries the sources, they are materialised somewhere Pike can read them.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { setEmbeddedAssets } from "../../server/src/embeddedAssets";
import {
  materializeEmbeddedPikeRuntime,
  resetEmbeddedPikeRuntime,
} from "../../server/src/features/pikeWorkerPaths";

const WORKER = "// worker\nint main(){ return 0; }\n";
const COMMON = "// common\n";

afterEach(() => {
  const dir = resetEmbeddedPikeRuntime();
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  setEmbeddedAssets({});
});

describe("materializeEmbeddedPikeRuntime", () => {
  test("returns undefined when the binary carries no Pike runtime", () => {
    setEmbeddedAssets({});
    expect(materializeEmbeddedPikeRuntime()).toBeUndefined();
  });

  test("writes the carried sources somewhere Pike can read them", () => {
    setEmbeddedAssets({
      pikeRuntime: {
        "worker.pike": new TextEncoder().encode(WORKER),
        "Common.pike": new TextEncoder().encode(COMMON),
      },
    });

    const dir = materializeEmbeddedPikeRuntime();
    expect(dir).toBeDefined();
    expect(readFileSync(`${dir}/worker.pike`, "utf-8")).toBe(WORKER);
    // Common.pike is `import Common;`-ed by worker.pike, so it has to land in
    // the same directory or the worker fails to compile.
    expect(readFileSync(`${dir}/Common.pike`, "utf-8")).toBe(COMMON);
  });

  test("materialises once and reuses the same directory", () => {
    setEmbeddedAssets({
      pikeRuntime: { "worker.pike": new TextEncoder().encode(WORKER) },
    });

    // Called on every spawn; re-extracting each time would leak a temp
    // directory per worker restart.
    expect(materializeEmbeddedPikeRuntime()).toBe(materializeEmbeddedPikeRuntime());
  });
});
