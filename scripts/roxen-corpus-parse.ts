#!/usr/bin/env bun
/**
 * Parse the Roxen corpus with the shipped grammar and report which files the
 * parser rejects.
 *
 * This is the tracked number behind the roxen-support change: it starts at 14
 * of 442 and is driven down by fixing grammar gaps upstream. Run it before and
 * after any grammar or WASM change.
 *
 *   bun run scripts/roxen-corpus-parse.ts [--corpus <dir>] [--json] [--quiet]
 *   bun run scripts/roxen-corpus-parse.ts --check           compare to baseline
 *   bun run scripts/roxen-corpus-parse.ts --write-baseline   record a new one
 *
 * The corpus defaults to $ROXEN_CORPUS, then /tank/projects/roxen-6.1. Obtain
 * one with:
 *
 *   git clone --depth 1 --branch rxnpatch/6.1 \
 *     https://github.com/pikelang/Roxen.git roxen-6.1
 *
 * Every file is decoded by detected encoding, never as UTF-8. Over half the
 * corpus is ISO-8859-1; reading those as UTF-8 manufactures U+FFFD characters
 * and distorts both the failure count and every position in it. For the same
 * reason, do not reach for `grep` to scan this tree — it classifies
 * ISO-8859-1 files as binary and reports no matches rather than an error, which
 * is how an early survey undercounted `#include <module.h>` by a factor of six.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Node } from "web-tree-sitter";
import { initParser, parse } from "../server/src/parser";
import { decodeSource } from "../server/src/util/sourceDecoder";

const DEFAULT_CORPUS = process.env.ROXEN_CORPUS ?? "/tank/projects/roxen-6.1";

/** Subtree of the corpus that holds Pike source. */
const CORPUS_SUBDIR = "server";

/** How many failing nodes to report per file before truncating. */
const MAX_NODES_PER_FILE = 5;

/**
 * Committed record of which files the grammar currently rejects.
 *
 * It holds paths rather than a bare count so that a fix and a regression
 * landing together cannot cancel out. Node positions are deliberately excluded:
 * they churn on any grammar change and would make the file unreviewable.
 */
const BASELINE_PATH = join(import.meta.dir, "..", "harness", "roxen-lab", "corpus-baseline.json");

interface Baseline {
  corpusRevision: string;
  total: number;
  failing: string[];
}

interface FailingNode {
  kind: "ERROR" | "MISSING";
  line: number;
  column: number;
  text: string;
}

interface FileResult {
  path: string;
  encoding: string;
  nodes: FailingNode[];
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Collect Pike source under `root`, in a stable order.
 *
 * `.pmod` directories are ordinary directories that happen to be modules, so
 * they are walked like any other; it is the file extension that decides.
 */
function discoverPikeFiles(root: string): string[] {
  const found: string[] = [];
  walk(root);
  return found.sort();

  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Unreadable directory — nothing to parse in it.
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue; // Never follow: the corpus has cycles.
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && (entry.name.endsWith(".pike") || entry.name.endsWith(".pmod"))) {
        found.push(full);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Depth-first walk collecting ERROR and MISSING nodes, bounded per file. */
function collectFailingNodes(root: Node): FailingNode[] {
  const nodes: FailingNode[] = [];
  const stack: Node[] = [root];

  while (stack.length > 0 && nodes.length < MAX_NODES_PER_FILE) {
    const node = stack.pop()!;
    if (node.isError || node.isMissing) {
      nodes.push({
        kind: node.isMissing ? "MISSING" : "ERROR",
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
        text: node.text.slice(0, 80).replace(/\s+/g, " ").trim(),
      });
      // Do not descend: the children of an ERROR node are the same defect.
      continue;
    }
    if (!node.hasError) continue; // Whole subtree is clean.
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i);
      if (child) stack.push(child);
    }
  }

  return nodes;
}

function examine(path: string): FileResult {
  const decoded = decodeSource(readFileSync(path));
  const tree = parse(decoded.text);
  const nodes = tree.rootNode.hasError ? collectFailingNodes(tree.rootNode) : [];
  tree.delete();
  return { path, encoding: decoded.encoding, nodes };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Options {
  corpus: string;
  json: boolean;
  quiet: boolean;
  check: boolean;
  writeBaseline: boolean;
}

function parseArgs(argv: string[]): Options {
  let corpus = DEFAULT_CORPUS;
  let json = false;
  let quiet = false;
  let check = false;
  let writeBaseline = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--corpus") corpus = argv[++i] ?? corpus;
    else if (argv[i] === "--json") json = true;
    else if (argv[i] === "--quiet") quiet = true;
    else if (argv[i] === "--check") check = true;
    else if (argv[i] === "--write-baseline") writeBaseline = true;
  }
  return { corpus: resolve(corpus), json, quiet, check, writeBaseline };
}

/**
 * The corpus checkout's commit, so a baseline names the tree it was taken on.
 *
 * Read from `.git` directly rather than by shelling out to git: this runs over
 * a checkout the script does not own, and a plain read cannot have side
 * effects on it.
 */
function corpusRevision(corpus: string): string {
  const gitDir = join(corpus, ".git");
  try {
    const head = readFileSync(join(gitDir, "HEAD"), "utf-8").trim();
    if (!head.startsWith("ref: ")) return head; // Detached HEAD is already a SHA.
    const ref = head.slice(5).trim();
    try {
      return readFileSync(join(gitDir, ref), "utf-8").trim();
    } catch {
      // Packed refs: the loose file is absent once git has packed it.
      const packed = readFileSync(join(gitDir, "packed-refs"), "utf-8");
      const line = packed.split("\n").find((l) => l.endsWith(` ${ref}`));
      return line ? line.split(" ")[0]! : "unknown";
    }
  } catch {
    return "unknown";
  }
}

/**
 * Compare against the committed baseline. Returns a process exit code.
 *
 * A file that started failing is a regression and fails the check. A file that
 * stopped failing is the point of the exercise, but it still fails the check —
 * the baseline is stale and must be re-recorded, or the next regression hides
 * behind the improvement.
 */
function checkAgainstBaseline(failing: string[], quiet: boolean): number {
  let baseline: Baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf-8")) as Baseline;
  } catch {
    console.error(`no baseline at ${BASELINE_PATH}; run with --write-baseline`);
    return 2;
  }

  const recorded = new Set(baseline.failing);
  const current = new Set(failing);
  const regressed = failing.filter((p) => !recorded.has(p));
  const fixed = baseline.failing.filter((p) => !current.has(p));

  for (const path of regressed) console.error(`REGRESSED: ${path} now fails to parse`);
  for (const path of fixed) console.error(`FIXED:     ${path} now parses — re-record the baseline`);

  if (regressed.length === 0 && fixed.length === 0) {
    if (!quiet) console.log(`baseline holds: ${failing.length} failing of ${baseline.total}`);
    return 0;
  }
  return 1;
}

async function main(): Promise<void> {
  const { corpus, json, quiet, check, writeBaseline } = parseArgs(process.argv.slice(2));

  const sourceRoot = join(corpus, CORPUS_SUBDIR);
  try {
    if (!statSync(sourceRoot).isDirectory()) throw new Error("not a directory");
  } catch {
    console.error(`corpus not found: ${sourceRoot}`);
    console.error("set --corpus <dir> or $ROXEN_CORPUS to a Roxen checkout");
    process.exit(2);
  }

  await initParser();

  const files = discoverPikeFiles(sourceRoot);
  const failures: FileResult[] = [];
  const byEncoding = new Map<string, number>();

  for (const file of files) {
    const result = examine(file);
    byEncoding.set(result.encoding, (byEncoding.get(result.encoding) ?? 0) + 1);
    if (result.nodes.length > 0) failures.push(result);
  }

  const failingPaths = failures.map((f) => relative(corpus, f.path)).sort();

  if (writeBaseline) {
    const baseline: Baseline = {
      corpusRevision: corpusRevision(corpus),
      total: files.length,
      failing: failingPaths,
    };
    writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, "utf-8");
    console.log(`wrote ${BASELINE_PATH}: ${failingPaths.length} failing of ${files.length}`);
    process.exit(0);
  }

  if (check) process.exit(checkAgainstBaseline(failingPaths, quiet));

  if (json) {
    console.log(JSON.stringify({
      corpus,
      total: files.length,
      failing: failures.length,
      encodings: Object.fromEntries([...byEncoding].sort()),
      failures: failures.map((f) => ({ ...f, path: relative(corpus, f.path) })),
    }, null, 2));
  } else {
    if (!quiet) {
      for (const failure of failures) {
        console.log(relative(corpus, failure.path));
        for (const node of failure.nodes) {
          console.log(`    ${node.kind} at ${node.line}:${node.column}  ${node.text}`);
        }
      }
      console.log("");
    }
    console.log(`corpus:    ${corpus}`);
    console.log(`parsed:    ${files.length} files`);
    console.log(`failing:   ${failures.length} files`);
    for (const [encoding, count] of [...byEncoding].sort()) {
      console.log(`  ${encoding.padEnd(12)} ${count}`);
    }
  }

  // Exit status reports whether the corpus is clean, so this can gate a change.
  process.exit(failures.length === 0 ? 0 : 1);
}

void main();
