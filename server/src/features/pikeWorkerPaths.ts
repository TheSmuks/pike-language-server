/**
 * Pike worker path resolution — extracted from PikeWorkerProcess to keep
 * each file under 500 lines.
 *
 * Resolves harness directory and worker script paths for both dev layout
 * (repo root) and VSIX layout (extension root).
 */

import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, statSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { getEmbeddedAssets } from "../embeddedAssets.js";

const _thisDir = typeof __dirname !== 'undefined'
  ? __dirname
  : dirname(fileURLToPath(import.meta.url));

/**
 * Resolve a directory by trying multiple candidate paths.
 * Returns the first path that exists and is a directory, or undefined.
 *
 * Supports both dev layout and VSIX layout:
 * - Dev:       server/dist/ → 3 levels up → repo root
 * - VSIX:      server/dist/ → 2 levels up → extension root
 */
export function resolveDir(...candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // Permission or access errors — treat as non-existent.
    }
  }
  return undefined;
}

/**
 * Resolve a file by trying multiple candidate paths.
 * Returns the first path that exists and is a file, or undefined.
 */
export function resolveFile(...candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Permission or access errors — treat as non-existent.
    }
  }
  return undefined;
}

// Dev layout: _thisDir = server/dist/; 3x ".." = repo root
export const DEV_ROOT = resolve(_thisDir, "..", "..", "..");
// VSIX layout: _thisDir = server/dist/; 2x ".." = extension root
export const VSIX_ROOT = resolve(_thisDir, "..", "..");
// Standalone layout: _thisDir IS the bundle directory (standalone/server.js),
// so the Pike runtime sits beside the bundle rather than under a server/ dir.
export const STANDALONE_ROOT = _thisDir;

/**
 * Directory holding the Pike runtime the worker is spawned with — worker.pike
 * and the Common module it imports.
 *
 * This is production code that ships in every distribution, not test
 * scaffolding. It used to live in `harness/`, which is why the standalone and
 * npm bundles went out without it for a while: their build scripts copied the
 * things that looked like product and skipped the directory that looked like
 * tests. Absence is not fatal — the server degrades to tree-sitter only — which
 * is exactly why it went unnoticed, and why check-standalone.mjs now asserts
 * the bundle carries it.
 */
export const PIKE_RUNTIME_DIR = resolveDir(
  join(DEV_ROOT, "server", "pike"),
  join(VSIX_ROOT, "server", "pike"),
  join(STANDALONE_ROOT, "pike"),
);
export const WORKER_SCRIPT = resolveFile(
  join(DEV_ROOT, "server", "pike", "worker.pike"),
  join(VSIX_ROOT, "server", "pike", "worker.pike"),
  join(STANDALONE_ROOT, "pike", "worker.pike"),
);
// pmp installs the introspect module under a package-named directory. The
// package was historically symlinked as `modules/Introspect`, but current pmp
// versions name it after the pike.json dependency key (`modules/pike_introspect`).
// Try both layouts so `resolve` works regardless of the installed pmp version.
export const INTROSPECT_PATH = resolveDir(
  join(DEV_ROOT, "modules", "Introspect", "src"),
  join(DEV_ROOT, "modules", "pike_introspect", "src"),
  join(VSIX_ROOT, "modules", "Introspect", "src"),
  join(VSIX_ROOT, "modules", "pike_introspect", "src"),
);

/**
 * Write the Pike sources carried inside a compiled binary to a temp directory,
 * returning it. Undefined when this build carries none.
 *
 * The worker is a separate `pike` process, so in-memory bytes are no use to
 * it — unlike the WASM blobs, these have to reach a real filesystem. Done once
 * and memoised: `buildSpawnCommand` runs on every worker restart, and
 * extracting per spawn would leak a directory each time.
 */
let embeddedRuntimeDir: string | undefined;

export function materializeEmbeddedPikeRuntime(): string | undefined {
  if (embeddedRuntimeDir) return embeddedRuntimeDir;

  const sources = getEmbeddedAssets().pikeRuntime;
  if (!sources || Object.keys(sources).length === 0) return undefined;

  const dir = mkdtempSync(join(tmpdir(), "pike-lsp-runtime-"));
  for (const [name, bytes] of Object.entries(sources)) {
    writeFileSync(join(dir, name), bytes);
  }
  embeddedRuntimeDir = dir;
  return dir;
}

/** Forget the materialised directory. Returns it so a caller can clean up. */
export function resetEmbeddedPikeRuntime(): string | undefined {
  const previous = embeddedRuntimeDir;
  embeddedRuntimeDir = undefined;
  return previous;
}

/**
 * The directory and worker script to spawn Pike with.
 *
 * On-disk layouts first, then the copy carried inside a compiled binary. The
 * order matters for development: a checkout's `server/pike` should win over
 * whatever a locally built binary happens to embed.
 */
export function resolvePikeRuntime(): { dir?: string; script?: string } {
  if (PIKE_RUNTIME_DIR && WORKER_SCRIPT) return { dir: PIKE_RUNTIME_DIR, script: WORKER_SCRIPT };
  const embedded = materializeEmbeddedPikeRuntime();
  if (!embedded) return {};
  return { dir: embedded, script: join(embedded, "worker.pike") };
}

// ---------------------------------------------------------------------------
// Spawn-command construction
// ---------------------------------------------------------------------------

export interface SpawnCommand {
  cmd: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Build the Pike worker spawn command, argument list, cwd, and environment.
 *
 * On Linux, wraps the binary in `nice` for CPU politeness under contention.
 * Merges libraryPath into LD_LIBRARY_PATH so Pike's native modules can find
 * shared libraries not on the default linker search path.
 */
export function buildSpawnCommand(
  pikeBinaryPath: string,
  niceValue: number,
  libraryPath: string | undefined,
): SpawnCommand {
  const runtime = resolvePikeRuntime();
  const baseArgs = ["-M", runtime.dir!];
  if (INTROSPECT_PATH) baseArgs.push("-M", INTROSPECT_PATH);
  baseArgs.push(runtime.script!);

  let cmd: string;
  let args: string[];

  if (niceValue > 0 && process.platform === "linux") {
    cmd = "nice";
    args = ["-n" + niceValue, pikeBinaryPath, ...baseArgs];
  } else {
    cmd = pikeBinaryPath;
    args = baseArgs;
  }

  const env = { ...process.env } as NodeJS.ProcessEnv;
  if (libraryPath) {
    const base = process.env.LD_LIBRARY_PATH ?? "";
    env.LD_LIBRARY_PATH = base ? `${libraryPath}:${base}` : libraryPath;
  }

  return { cmd, args, cwd: VSIX_ROOT || DEV_ROOT, env };
}

/**
 * Throw a descriptive error if the Pike runtime cannot be resolved in any
 * supported layout. The message names all three, because which one is expected
 * depends on how the server was installed.
 */
export function assertPikeRuntimeReady(): void {
  const runtime = resolvePikeRuntime();
  if (runtime.dir && runtime.script) return;
  if (!PIKE_RUNTIME_DIR) throw new Error(
    `Pike worker: runtime directory not found.\n` +
    `  Dev layout:        ${join(DEV_ROOT, "server", "pike")}\n` +
    `  VSIX layout:       ${join(VSIX_ROOT, "server", "pike")}\n` +
    `  Standalone layout: ${join(STANDALONE_ROOT, "pike")}`,
  );
  if (!WORKER_SCRIPT) throw new Error(
    `Pike worker: worker.pike not found.\n` +
    `  Dev layout:        ${join(DEV_ROOT, "server", "pike", "worker.pike")}\n` +
    `  VSIX layout:       ${join(VSIX_ROOT, "server", "pike", "worker.pike")}\n` +
    `  Standalone layout: ${join(STANDALONE_ROOT, "pike", "worker.pike")}`,
  );
}
