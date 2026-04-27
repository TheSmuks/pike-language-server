/**
 * Runner: spawns introspect.pike on a corpus file, captures JSON output.
 */

import { resolve, relative, join } from "node:path";
import { readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import type { IntrospectionResult } from "./types";
import { readSnapshot, writeSnapshot, diffSnapshot } from "./snapshot";

// ---------------------------------------------------------------------------
// Project root detection
// ---------------------------------------------------------------------------

function findProjectRoot(start: string = import.meta.dir): string {
  let dir = start;
  for (let i = 0; i < 20; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not find project root (no package.json found)");
}

export const PROJECT_ROOT = findProjectRoot();
export const CORPUS_DIR = join(PROJECT_ROOT, "corpus", "files");
export const SNAPSHOTS_DIR = join(PROJECT_ROOT, "harness", "snapshots");
export const INTROSPECT_SCRIPT = join(PROJECT_ROOT, "harness", "introspect.pike");

// ---------------------------------------------------------------------------
// Runner options
// ---------------------------------------------------------------------------

export interface RunnerOptions {
  /** Prepend #pragma strict_types before compilation */
  strict?: boolean;
  /** Add -M <path> to Pike invocation */
  modulePath?: string;
  /** Add -I <path> to Pike invocation */
  includePath?: string;
}

// Cross-file corpus entries that need special flags.
const CROSS_FILE_FLAGS: Record<string, RunnerOptions> = {
  "cross-lib-consumer.pike": { strict: true, includePath: "." },
  "cross-lib-user.pike": { strict: true, modulePath: "." },
};

// ---------------------------------------------------------------------------
// Core: run introspect.pike on a single file
// ---------------------------------------------------------------------------

export async function runIntrospect(
  corpusFile: string,
  opts: RunnerOptions = {},
): Promise<IntrospectionResult> {
  const absCorpusFile = resolve(PROJECT_ROOT, corpusFile);
  if (!existsSync(absCorpusFile)) {
    return {
      file: corpusFile,
      pike_version: "",
      compilation: { exit_code: -1, strict_types: opts.strict ?? false },
      diagnostics: [],
      autodoc: null,
      error: `File not found: ${corpusFile}`,
    };
  }

  const args: string[] = [];
  if (opts.strict) args.push("--strict");
  if (opts.modulePath) {
    args.push("--module-path", resolve(PROJECT_ROOT, opts.modulePath));
  }
  if (opts.includePath) {
    args.push("--include-path", resolve(PROJECT_ROOT, opts.includePath));
  }
  args.push(absCorpusFile);

  const proc = Bun.spawn(["pike", INTROSPECT_SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: PROJECT_ROOT,
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;

  if (exitCode !== 0 && !stdout.trim()) {
    return {
      file: corpusFile,
      pike_version: "",
      compilation: { exit_code: exitCode, strict_types: opts.strict ?? false },
      diagnostics: [],
      autodoc: null,
      error: stderr.trim() || `pike exited with code ${exitCode}`,
    };
  }

  try {
    const result: IntrospectionResult = JSON.parse(stdout);
    // Normalize file path to relative from project root
    if (result.file) {
      result.file = relative(PROJECT_ROOT, resolve(PROJECT_ROOT, result.file));
    }
    return result;
  } catch (e) {
    return {
      file: corpusFile,
      pike_version: "",
      compilation: { exit_code: exitCode, strict_types: opts.strict ?? false },
      diagnostics: [],
      autodoc: null,
      error: `JSON parse error: ${(e as Error).message}\nRaw output:\n${stdout.slice(0, 500)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Corpus helpers
// ---------------------------------------------------------------------------

export function listCorpusFiles(): string[] {
  return readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith(".pike") || f.endsWith(".pmod"))
    .sort();
}

export function getRunnerOptionsForFile(filename: string): RunnerOptions {
  const base: RunnerOptions = { strict: true };
  const extra = CROSS_FILE_FLAGS[filename];
  return extra ? { ...base, ...extra } : base;
}

/** Run introspect on every corpus file, returning name→result map. */
export async function runAllCorpus(): Promise<Map<string, IntrospectionResult>> {
  const results = new Map<string, IntrospectionResult>();
  const files = listCorpusFiles();

  // Run sequentially to avoid Pike process contention
  for (const f of files) {
    const opts = getRunnerOptionsForFile(f);
    results.set(f, await runIntrospect(`corpus/files/${f}`, opts));
  }

  return results;
}

// ---------------------------------------------------------------------------
// CLI: snapshot generation and verification
// ---------------------------------------------------------------------------

async function generateSnapshots(): Promise<void> {
  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const files = listCorpusFiles();
  let generated = 0;

  for (const f of files) {
    const opts = getRunnerOptionsForFile(f);
    const result = await runIntrospect(`corpus/files/${f}`, opts);
    const name = f.replace(/\.(pike|pmod)$/, "");
    writeSnapshot(name, result);
    generated++;
  }

  console.log(`Generated ${generated} snapshots in ${relative(PROJECT_ROOT, SNAPSHOTS_DIR)}/`);
}

async function verifySnapshots(): Promise<boolean> {
  const files = listCorpusFiles();
  let failures = 0;

  for (const f of files) {
    const name = f.replace(/\.(pike|pmod)$/, "");
    const expected = readSnapshot(name);

    if (!expected) {
      console.error(`MISSING: no snapshot for ${f} (run --snapshot first)`);
      failures++;
      continue;
    }

    const opts = getRunnerOptionsForFile(f);
    const actual = await runIntrospect(`corpus/files/${f}`, opts);
    const diffs = diffSnapshot(actual, expected);

    if (diffs && diffs.length > 0) {
      console.error(`DIFF: ${f}`);
      for (const d of diffs) {
        console.error(`  ${d.field}: expected ${JSON.stringify(d.expected)}, got ${JSON.stringify(d.actual)}`);
      }
      failures++;
    } else {
      console.log(`OK: ${f}`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} file(s) failed verification.`);
    return false;
  }
  console.log(`\nAll ${files.length} snapshots verified.`);
  return true;
}

// CLI entry point
const args = process.argv.slice(2);
if (args.includes("--snapshot")) {
  generateSnapshots().then(() => process.exit(0));
} else if (args.includes("--verify")) {
  verifySnapshots().then((ok) => process.exit(ok ? 0 : 1));
}
