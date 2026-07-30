#!/usr/bin/env bun
/**
 * Build-time script that extracts Roxen's vocabulary into a JSON index.
 *
 * The output is committed as server/src/data/roxen-index.json. It is what makes
 * a Roxen file usable on a machine that has never run Roxen: the constants its
 * headers define and the Roxen and RXML API surface, available for hover and
 * completion with no installation present. A detected installation always
 * takes precedence over this — see roxenIndex.ts.
 *
 *   bun run scripts/build-roxen-index.ts [--roxen <dir>] [--check]
 *
 * The source tree defaults to $ROXEN_CORPUS, then /tank/projects/roxen-6.1, and
 * must be checked out at the pinned revision below. `--check` regenerates and
 * compares instead of writing, which is how reproducibility is verified.
 *
 * Pinned to a commit rather than to rxnpatch/6.1: the branch moves, and an
 * index that changes when an unrelated upstream commit lands would make bundle
 * diffs unreviewable and any reproducibility claim false.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { decodeSource } from "../server/src/util/sourceDecoder";
import { renderAutodoc } from "../server/src/features/autodocRenderer";
import { parseXml, type XmlNode } from "../server/src/features/xmlParser";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** The Roxen revision this index is generated from. */
const PINNED_REVISION = "4f1d04f82b3ea95f680cddab552d4912990c9c2f";

const ROXEN_ROOT = process.env.ROXEN_CORPUS ?? "/tank/projects/roxen-6.1";

const OUTPUT_PATH = join(import.meta.dir, "..", "server", "src", "data", "roxen-index.json");

/** Roxen's thirteen include files, in the order they appear on disk. */
const HEADERS = [
  "config.h", "config_interface.h", "module.h", "module_constants.h",
  "request_trace.h", "roxen.h", "security.h", "stat.h", "testsuite.h",
  "timers.h", "udp.h", "variables.h", "version.h",
] as const;

/**
 * Modules whose documented API is worth carrying.
 *
 * `Roxen.pmod` and `RXML.pmod` are what module code actually calls;
 * `module.pike` is the prototype every Roxen module inherits, so its methods
 * (`find_file`, `query_location`, `defvar`, …) are the ones a developer is
 * most often looking at.
 */
const API_SOURCES: readonly { path: string; namespace: string }[] = [
  { path: join("server", "etc", "modules", "Roxen.pmod"), namespace: "Roxen" },
  { path: join("server", "etc", "modules", "RXML.pmod", "module.pmod"), namespace: "RXML" },
  { path: join("server", "base_server", "module.pike"), namespace: "RoxenModule" },
];

const PIKE_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConstantEntry {
  /** Rendered declaration, e.g. `#define TYPE_STRING 1`. */
  signature: string;
  /** Header the symbol comes from, e.g. `module.h`. */
  header: string;
  /** Autodoc or leading comment, as markdown. Empty when undocumented. */
  markdown: string;
}

interface SymbolEntry {
  signature: string;
  markdown: string;
}

interface RoxenIndex {
  roxenRevision: string;
  roxenVersion: string;
  /** Flat preprocessor and constant vocabulary, keyed by bare name. */
  constants: Record<string, ConstantEntry>;
  /** Dotted API surface, keyed by fully-qualified name. */
  symbols: Record<string, SymbolEntry>;
}

// ---------------------------------------------------------------------------
// Header extraction
// ---------------------------------------------------------------------------

const DEFINE_RE = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_][A-Za-z0-9_]*)(\([^)]*\))?[ \t]*(.*)$/;
const CONSTANT_RE = /^[ \t]*constant[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*([^;]*);/;

/** Strip `//!` / `//` comment markers from a run of doc lines. */
function renderDocLines(lines: readonly string[]): string {
  return lines
    .map((l) => l.replace(/^[ \t]*\/\/!?[ \t]?/, "").trimEnd())
    .join("\n")
    .trim();
}

/**
 * Pull `#define` and `constant` declarations out of one header.
 *
 * Deliberately line-based rather than tree-sitter-driven: these are
 * preprocessor headers, most of whose content is not parseable Pike, and the
 * two declaration forms are unambiguous at line granularity. A trailing `\`
 * continuation is joined so a multi-line macro keeps its whole body.
 */
function extractHeader(path: string, header: string, into: Record<string, ConstantEntry>): void {
  const text = decodeSource(readFileSync(path)).text;
  const lines = text.split("\n");

  let doc: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;

    if (/^[ \t]*\/\//.test(line)) { doc.push(line); continue; }
    if (line.trim() === "") { doc = []; continue; }

    // Join backslash continuations so a macro body is captured whole.
    while (line.endsWith("\\") && i + 1 < lines.length) {
      line = `${line.slice(0, -1).trimEnd()} ${lines[++i]!.trim()}`;
    }

    const define = DEFINE_RE.exec(line);
    if (define) {
      const [, name, args, body] = define;
      const value = body!.replace(/\s*\/[/*].*$/, "").trim();
      into[name!] = {
        signature: `#define ${name}${args ?? ""}${value ? ` ${value}` : ""}`,
        header,
        markdown: renderDocLines(doc),
      };
      doc = [];
      continue;
    }

    const constant = CONSTANT_RE.exec(line);
    if (constant) {
      const [, name, value] = constant;
      into[name!] = {
        signature: `constant ${name} = ${value!.trim()};`,
        header,
        markdown: renderDocLines(doc),
      };
    }
    doc = [];
  }
}

// ---------------------------------------------------------------------------
// API extraction (via Pike's own AutoDoc extractor)
// ---------------------------------------------------------------------------

/** Run Pike's AutoDoc extractor over a file, returning its XML or null. */
function extractAutodocXml(filePath: string): string | null {
  const code = `object ns = Tools.AutoDoc.PikeExtractor.extractNamespace(Stdio.read_file(${JSON.stringify(filePath)}), ${JSON.stringify(filePath)}, "predef", Tools.AutoDoc.FLAG_KEEP_GOING); if(ns) write(ns->xml());`;
  try {
    const stdout = execFileSync("pike", ["-e", code], {
      timeout: PIKE_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const trimmed = stdout.trim();
    return trimmed.startsWith("<") ? trimmed : null;
  } catch {
    return null; // Timeout, crash, or nothing extractable — skip this source.
  }
}

function findChild(node: XmlNode, tag: string): XmlNode | null {
  if (node.type !== "element" || !node.children) return null;
  return node.children.find((c) => c.type === "element" && c.tag === tag) ?? null;
}

/** Walk the AutoDoc XML collecting documented symbols under `prefix`. */
function collectSymbols(root: XmlNode, prefix: string): { fqn: string; localName: string }[] {
  const results: { fqn: string; localName: string }[] = [];
  const ns = root.tag === "namespace" ? root : findChild(root, "namespace");
  if (!ns) return results;

  walk(ns, prefix);
  return results;

  function walk(node: XmlNode, currentPrefix: string): void {
    if (node.type !== "element" || !node.children) return;
    for (const child of node.children) {
      if (child.type !== "element") continue;
      const name = child.attrs?.["name"];

      if (child.tag === "docgroup") {
        const homogen = child.attrs?.["homogen-name"];
        if (homogen) results.push({ fqn: `${currentPrefix}.${homogen}`, localName: homogen });
      } else if (child.tag === "class" && name) {
        results.push({ fqn: `${currentPrefix}.${name}`, localName: name });
        walk(child, `${currentPrefix}.${name}`);
      } else if (child.tag === "enum" && name) {
        results.push({ fqn: `${currentPrefix}.${name}`, localName: name });
      }
    }
  }
}

function extractApi(root: string, into: Record<string, SymbolEntry>): number {
  let count = 0;
  for (const source of API_SOURCES) {
    const abs = join(root, source.path);
    if (!existsSync(abs)) {
      console.warn(`  skipping ${source.path}: not present`);
      continue;
    }
    const xml = extractAutodocXml(abs);
    if (!xml) {
      console.warn(`  skipping ${source.path}: no AutoDoc XML`);
      continue;
    }
    for (const sym of collectSymbols(parseXml(xml), source.namespace)) {
      const rendered = renderAutodoc(xml, sym.localName);
      if (!rendered) continue;
      into[sym.fqn] = { signature: rendered.signature, markdown: rendered.markdown };
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** Read `roxen_ver`/`roxen_build` out of version.h. */
function readVersion(root: string): string {
  const text = decodeSource(readFileSync(join(root, "server", "etc", "include", "version.h"))).text;
  const ver = /constant\s+roxen_ver\s*=\s*"([^"]+)"/.exec(text)?.[1] ?? "0";
  const build = /constant\s+roxen_build\s*=\s*"([^"]+)"/.exec(text)?.[1];
  return build ? `${ver}.${build}` : ver;
}

/** Sort an object's keys so output is stable regardless of insertion order. */
function sortKeys<T>(obj: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function build(root: string): RoxenIndex {
  const constants: Record<string, ConstantEntry> = {};
  for (const header of HEADERS) {
    const path = join(root, "server", "etc", "include", header);
    if (!existsSync(path)) {
      console.warn(`  skipping ${header}: not present`);
      continue;
    }
    extractHeader(path, header, constants);
  }
  console.log(`Constants: ${Object.keys(constants).length}`);

  const symbols: Record<string, SymbolEntry> = {};
  console.log(`API symbols: ${extractApi(root, symbols)}`);

  return {
    roxenRevision: PINNED_REVISION,
    roxenVersion: readVersion(root),
    constants: sortKeys(constants),
    symbols: sortKeys(symbols),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  const rootIndex = argv.indexOf("--roxen");
  const root = rootIndex >= 0 ? argv[rootIndex + 1]! : ROXEN_ROOT;

  if (!existsSync(join(root, "server", "etc", "include", "module.h"))) {
    console.error(`no Roxen tree at ${root}`);
    console.error("set --roxen <dir> or $ROXEN_CORPUS to a Roxen checkout");
    process.exit(2);
  }

  // The index names a revision; generating it from a different tree would make
  // that name a lie. Warn rather than fail, so the generator stays usable for
  // experimenting against another Roxen.
  const head = readRevision(root);
  if (head !== PINNED_REVISION) {
    console.warn(`WARNING: tree is at ${head}, index is pinned to ${PINNED_REVISION}`);
  }

  const json = `${JSON.stringify(build(root), null, 2)}\n`;

  if (check) {
    const existing = existsSync(OUTPUT_PATH) ? readFileSync(OUTPUT_PATH, "utf-8") : "";
    if (existing === json) {
      console.log("index is reproducible: regenerated output is byte-identical");
      process.exit(0);
    }
    console.error("index differs from the committed one — re-run without --check");
    process.exit(1);
  }

  writeFileSync(OUTPUT_PATH, json, "utf-8");
  const kb = (Buffer.byteLength(json, "utf-8") / 1024).toFixed(1);
  console.log(`Wrote ${OUTPUT_PATH} (${kb} KB)`);
}

/** The checkout's HEAD commit, read from `.git` without invoking git. */
function readRevision(root: string): string {
  try {
    const head = readFileSync(join(root, ".git", "HEAD"), "utf-8").trim();
    if (!head.startsWith("ref: ")) return head;
    const ref = head.slice(5).trim();
    try {
      return readFileSync(join(root, ".git", ref), "utf-8").trim();
    } catch {
      const packed = readFileSync(join(root, ".git", "packed-refs"), "utf-8");
      return packed.split("\n").find((l) => l.endsWith(` ${ref}`))?.split(" ")[0] ?? "unknown";
    }
  } catch {
    return "unknown";
  }
}

main();
