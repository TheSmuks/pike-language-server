/**
 * Golden-file diagnostics infrastructure for the LSP's tree-sitter diagnostics.
 *
 * For each corpus file, this module:
 *   1. Parses with tree-sitter
 *   2. Extracts parse diagnostics (ERROR nodes)
 *   3. Builds a symbol table and runs lint rules
 *   4. Serializes the combined output as a portable golden file
 *
 * This tests the LSP's own fast-path diagnostics — the tree-sitter-based
 * diagnostics that run on every keystroke. It complements the existing
 * harness snapshots that capture Pike compiler diagnostics.
 *
 * The golden files are intentionally separate from the Pike introspection
 * snapshots because they test a different pipeline (tree-sitter vs Pike
 * compiler) and have different update cadences.
 */

import { resolve, join, dirname, basename } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import type { Diagnostic } from "vscode-languageserver/node";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Serializable form of an LSP Diagnostic, with range as plain objects. */
export interface GoldenDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity: number;
  code: string | number | undefined;
  source: string | undefined;
  message: string;
}

/** The full golden file structure for one corpus file. */
export interface DiagnosticGoldenFile {
  /** Corpus file path relative to project root. */
  file: string;
  /** Combined diagnostics from parse + lint. */
  diagnostics: GoldenDiagnostic[];
  /** Number of parse diagnostics (first N entries). */
  parseCount: number;
  /** Number of lint diagnostics (remaining entries). */
  lintCount: number;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const HARNESS_DIR = resolve(import.meta.dir, "..");
const PROJECT_ROOT = resolve(HARNESS_DIR, "..");
const CORPUS_DIR = join(PROJECT_ROOT, "corpus", "files");
const GOLDEN_DIR = join(HARNESS_DIR, "diagnostic-goldens");

export { PROJECT_ROOT, CORPUS_DIR, GOLDEN_DIR };

// ---------------------------------------------------------------------------
// Diagnostic serialization
// ---------------------------------------------------------------------------

function diagnosticToGolden(d: Diagnostic): GoldenDiagnostic {
  return {
    range: {
      start: { line: d.range.start.line, character: d.range.start.character },
      end: { line: d.range.end.line, character: d.range.end.character },
    },
    severity: d.severity ?? 1,
    code: d.code as string | number | undefined,
    source: d.source ?? undefined,
    message: d.message,
  };
}

// ---------------------------------------------------------------------------
// Core: produce golden diagnostics for a single source file
// ---------------------------------------------------------------------------

/**
 * Run the LSP's tree-sitter diagnostics pipeline on a source string.
 *
 * Returns parse diagnostics first, then lint diagnostics.
 * Does NOT include Pike compiler diagnostics (those are in the harness snapshots).
 */
export async function produceDiagnostics(
  source: string,
  uri: string,
): Promise<DiagnosticGoldenFile> {
  const { initParser, parse } = await import("../../server/src/parser");
  const { getParseDiagnostics } = await import("../../server/src/features/diagnostics");
  const { buildSymbolTable } = await import("../../server/src/features/symbolTable");
  const { runLintRules } = await import("../../server/src/features/lintRules");

  await initParser();

  const tree = parse(source);
  const lines = source.split('\n');
  const parseDiags = tree ? getParseDiagnostics(tree, lines) : [];
  const lintDiags = tree ? runLintRules(tree, buildSymbolTable(tree, uri, 1), source) : [];

  return {
    file: uri,
    parseCount: parseDiags.length,
    lintCount: lintDiags.length,
    diagnostics: [
      ...parseDiags.map(diagnosticToGolden),
      ...lintDiags.map(diagnosticToGolden),
    ],
  };
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
    } else if (entry.isDirectory() && entry.name.endsWith(".pmod")) {
      const subDir = join(CORPUS_DIR, entry.name);
      const subEntries = readdirSync(subDir, { withFileTypes: true });
      for (const sub of subEntries) {
        if (sub.isFile() && (sub.name.endsWith(".pike") || sub.name.endsWith(".pmod"))) {
          results.push(`${entry.name}/${sub.name}`);
        }
      }
    }
  }
  return results.sort();
}

/** Derive a flat golden filename from a corpus file path. */
export function goldenNameForFile(corpusFile: string): string {
  return corpusFile.replace(/\.(pike|pmod)$/, "").replace(/\//g, "--") + ".golden.json";
}

// ---------------------------------------------------------------------------
// Golden file read / write / diff
// ---------------------------------------------------------------------------

export function readGolden(name: string): DiagnosticGoldenFile | null {
  const path = join(GOLDEN_DIR, name);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as DiagnosticGoldenFile;
}

export function writeGolden(name: string, data: DiagnosticGoldenFile): void {
  mkdirSync(GOLDEN_DIR, { recursive: true });
  const path = join(GOLDEN_DIR, name);
  // Write with sorted keys for readable diffs
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export interface GoldenDiff {
  kind: "missing_golden" | "count_mismatch" | "diagnostic_mismatch";
  detail: string;
}

export function diffGolden(
  actual: DiagnosticGoldenFile,
  expected: DiagnosticGoldenFile,
): GoldenDiff[] {
  const diffs: GoldenDiff[] = [];

  if (actual.parseCount !== expected.parseCount || actual.lintCount !== expected.lintCount) {
    diffs.push({
      kind: "count_mismatch",
      detail: `parse: expected ${expected.parseCount}, got ${actual.parseCount}; lint: expected ${expected.lintCount}, got ${actual.lintCount}`,
    });
  }

  if (actual.diagnostics.length !== expected.diagnostics.length) {
    diffs.push({
      kind: "count_mismatch",
      detail: `total diagnostics: expected ${expected.diagnostics.length}, got ${actual.diagnostics.length}`,
    });
    return diffs;
  }

  for (let i = 0; i < actual.diagnostics.length; i++) {
    const a = actual.diagnostics[i];
    const e = expected.diagnostics[i];
    if (JSON.stringify(a) !== JSON.stringify(e)) {
      diffs.push({
        kind: "diagnostic_mismatch",
        detail: `diagnostic[${i}]: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`,
      });
    }
  }

  return diffs;
}

// ---------------------------------------------------------------------------
// CLI: generate / verify golden files
// ---------------------------------------------------------------------------

async function generateGoldens(): Promise<void> {
  const files = listCorpusFiles();
  let generated = 0;

  for (const f of files) {
    const absPath = resolve(CORPUS_DIR, f);
    const source = readFileSync(absPath, "utf-8");
    const golden = await produceDiagnostics(source, `corpus/files/${f}`);
    const name = goldenNameForFile(f);
    writeGolden(name, golden);
    generated++;
  }

  console.log(`Generated ${generated} diagnostic golden files in ${GOLDEN_DIR}/`);
}

async function verifyGoldens(): Promise<boolean> {
  const files = listCorpusFiles();
  let failures = 0;

  for (const f of files) {
    const name = goldenNameForFile(f);
    const expected = readGolden(name);

    if (!expected) {
      console.error(`MISSING: no golden file for ${f} (run --diagnostics-golden first)`);
      failures++;
      continue;
    }

    const absPath = resolve(CORPUS_DIR, f);
    const source = readFileSync(absPath, "utf-8");
    const actual = await produceDiagnostics(source, `corpus/files/${f}`);
    const diffs = diffGolden(actual, expected);

    if (diffs.length > 0) {
      console.error(`DIFF: ${f}`);
      for (const d of diffs) {
        console.error(`  ${d.kind}: ${d.detail}`);
      }
      failures++;
    } else {
      console.log(`OK: ${f}`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} file(s) failed golden diagnostics verification.`);
    return false;
  }
  console.log(`\nAll ${files.length} diagnostic golden files verified.`);
  return true;
}

// CLI entry point
const args = process.argv.slice(2);
if (args.includes("--diagnostics-golden")) {
  generateGoldens().then(() => process.exit(0));
} else if (args.includes("--diagnostics-verify")) {
  verifyGoldens().then((ok: boolean) => process.exit(ok ? 0 : 1));
}
