/**
 * Runner: spawns introspect.pike on a corpus file, captures JSON output.
 */

import { resolve, relative, join } from "node:path";
import { readdirSync, existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
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
export const RESOLVE_SNAPSHOTS_DIR = join(PROJECT_ROOT, "harness", "resolve-snapshots");
export const INTROSPECT_SCRIPT = join(PROJECT_ROOT, "harness", "introspect.pike");
export const RESOLVE_SCRIPT = join(PROJECT_ROOT, "harness", "resolve.pike");

/** Pike binary name/path. Configurable via PIKE_BINARY env var, defaults to "pike". */
export const PIKE_BINARY = process.env.PIKE_BINARY ?? "pike";


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

// Per-file compilation metadata from corpus/corpus.json.
// Replaces the former CROSS_FILE_FLAGS hardcoded map (decision 0005 §Deferred Items).
interface CorpusManifest {
  files: Record<string, RunnerOptions>;
}

function loadCorpusManifest(): Record<string, RunnerOptions> {
  const manifestPath = join(PROJECT_ROOT, "corpus", "corpus.json");
  if (!existsSync(manifestPath)) return {};
  try {
    const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
    return (raw as CorpusManifest).files ?? {};
  } catch {
    return {};
  }
}

const CORPUS_MANIFEST = loadCorpusManifest();

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
      symbols: [],
      error: `File not found: ${corpusFile}`,
    };
  }
  const args: string[] = [];
  if (opts.strict) args.push("--strict");
  args.push("--pike-binary", PIKE_BINARY);
  if (opts.modulePath) {
    args.push("--module-path", resolve(PROJECT_ROOT, opts.modulePath));
  }
  if (opts.includePath) {
    args.push("--include-path", resolve(PROJECT_ROOT, opts.includePath));
  }
  args.push(absCorpusFile);

  const proc = Bun.spawn([PIKE_BINARY, INTROSPECT_SCRIPT, ...args], {
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
      symbols: [],
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
      symbols: [],
      error: `JSON parse error: ${(e as Error).message}\nRaw output:\n${stdout.slice(0, 500)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Corpus helpers
// ---------------------------------------------------------------------------

export function listCorpusFiles(): string[] {
  const results: string[] = [];
  const entries = readdirSync(CORPUS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && (entry.name.endsWith(".pike") || entry.name.endsWith(".pmod"))) {
      results.push(entry.name);
    }
    // .pmod directory modules are NOT listed individually.
    // Pike resolves them as whole modules via -M path.
    // Their contents are tested via cross-pmod-user.pike (consumer file).
  }
  return results.sort();
}

/** Derive a flat snapshot name from a corpus file path. */
export function snapshotNameForFile(corpusFile: string): string {
  return corpusFile.replace(/\.(pike|pmod)$/, "");
}

export function getRunnerOptionsForFile(filename: string): RunnerOptions {
  const base: RunnerOptions = { strict: false };
  const extra = CORPUS_MANIFEST[filename];
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
// Resolution introspection via resolve.pike
// ---------------------------------------------------------------------------

export interface ResolutionResult {
  file: string;
  pike_version: string;
  resolutions: Array<{
    reference: string;
    kind: string;
    line: number;
    target_file: string | null;
    alias?: string | null;
    resolve_error?: string;
    symbols?: Array<{
      name: string;
      kind: string;
      defined_file?: string;
      line?: number;
      members?: Array<{ name: string; kind: string }>;
    }>;
  }>;
  error: string | null;
}

/** Run resolve.pike on a single corpus file. */
export async function runResolve(
  corpusFile: string,
  opts: RunnerOptions = {},
): Promise<ResolutionResult> {
  const absCorpusFile = resolve(PROJECT_ROOT, corpusFile);
  if (!existsSync(absCorpusFile)) {
    return {
      file: corpusFile,
      pike_version: "",
      resolutions: [],
      error: `File not found: ${corpusFile}`,
    };
  }

  const args: string[] = [];
  // Always pass the corpus directory as module path so .pmod resolution works
  args.push("--module-path", CORPUS_DIR);
  // Forward additional module paths from corpus.json
  if (opts.modulePath) {
    args.push("--module-path", resolve(PROJECT_ROOT, opts.modulePath));
  }
  args.push(absCorpusFile);

  const proc = Bun.spawn([PIKE_BINARY, RESOLVE_SCRIPT, ...args], {
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
      resolutions: [],
      error: stderr.trim() || `pike exited with code ${exitCode}`,
    };
  }

  try {
    const result: ResolutionResult = JSON.parse(stdout);
    // Normalize file path to relative
    if (result.file && result.file.startsWith("/")) {
      result.file = relative(PROJECT_ROOT, result.file);
    }
    // Normalize all target_file paths to relative
    for (const r of result.resolutions) {
      if (r.target_file && r.target_file.startsWith("/")) {
        r.target_file = relative(PROJECT_ROOT, r.target_file);
      }
      if (r.symbols) {
        for (const s of r.symbols) {
          if (s.defined_file && s.defined_file.startsWith("/")) {
            s.defined_file = relative(PROJECT_ROOT, s.defined_file);
          }
        }
      }
    }
    return result;
  } catch (e) {
    return {
      file: corpusFile,
      pike_version: "",
      resolutions: [],
      error: `JSON parse error: ${(e as Error).message}\nRaw output:\n${stdout.slice(0, 500)}`,
    };
  }
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
    const name = snapshotNameForFile(f);
    writeSnapshot(name, result);
    generated++;
  }

  console.log(`Generated ${generated} snapshots in ${relative(PROJECT_ROOT, SNAPSHOTS_DIR)}/`);
}

async function verifySnapshots(): Promise<boolean> {
  const files = listCorpusFiles();
  let failures = 0;

  for (const f of files) {
    const name = snapshotNameForFile(f);
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

// ---------------------------------------------------------------------------
// Resolution snapshot generation and verification
// ---------------------------------------------------------------------------

const CROSS_FILE_CORPUS = [
  "cross-inherit-simple-b.pike",
  "cross-inherit-rename-b.pike",
  "cross-inherit-chain-b.pike",
  "cross-inherit-chain-c.pike",
  "cross-import-b.pike",
  "cross-pmod-user.pike",
  "cross-lib-user.pike",
];

async function generateResolveSnapshots(): Promise<void> {
  mkdirSync(RESOLVE_SNAPSHOTS_DIR, { recursive: true });
  let generated = 0;

  for (const f of CROSS_FILE_CORPUS) {
    const opts = getRunnerOptionsForFile(f);
    const result = await runResolve(`corpus/files/${f}`, opts);
    const name = snapshotNameForFile(f);
    const path = join(RESOLVE_SNAPSHOTS_DIR, `${name}-resolve.json`);
    writeFileSync(path, JSON.stringify(result, null, 2) + "\n");
    generated++;
  }

  console.log(`Generated ${generated} resolution snapshots in ${relative(PROJECT_ROOT, RESOLVE_SNAPSHOTS_DIR)}/`);
}

async function verifyResolveSnapshots(): Promise<boolean> {
  let failures = 0;

  for (const f of CROSS_FILE_CORPUS) {
    const name = snapshotNameForFile(f);
    const path = join(RESOLVE_SNAPSHOTS_DIR, `${name}-resolve.json`);

    if (!existsSync(path)) {
      console.error(`MISSING: no resolution snapshot for ${f} (run --resolve-snapshot first)`);
      failures++;
      continue;
    }

    const expected = JSON.parse(readFileSync(path, "utf-8"));
    const opts = getRunnerOptionsForFile(f);
    const actual = await runResolve(`corpus/files/${f}`, opts);

    // Normalize both actual and expected for comparison (Pike's JSON key order is non-deterministic)
    function sortKeys(obj: unknown): unknown {
      if (obj === null || obj === undefined || typeof obj !== "object") return obj;
      if (Array.isArray(obj)) return obj.map(sortKeys);
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
        sorted[key] = sortKeys((obj as Record<string, unknown>)[key]);
      }
      return sorted;
    }

    const actualNorm = sortKeys(actual);
    const expectedNorm = sortKeys(expected);

    if (JSON.stringify(actualNorm) !== JSON.stringify(expectedNorm)) {
      console.error(`DIFF: ${f} (resolution snapshot)`);
      failures++;
    } else {
      console.log(`OK: ${f} (resolution)`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} file(s) failed resolution verification.`);
    return false;
  }
  console.log(`\nAll ${CROSS_FILE_CORPUS.length} resolution snapshots verified.`);
  return true;
}
// CLI entry point
const args = process.argv.slice(2);
if (args.includes("--snapshot")) {
  generateSnapshots().then(() => process.exit(0));
} else if (args.includes("--resolve-snapshot")) {
  generateResolveSnapshots().then(() => process.exit(0));
} else if (args.includes("--resolve-verify")) {
  verifyResolveSnapshots().then((ok: boolean) => process.exit(ok ? 0 : 1));
} else if (args.includes("--verify")) {
  verifySnapshots().then((ok) => process.exit(ok ? 0 : 1));
}
