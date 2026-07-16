#!/usr/bin/env bun
/**
 * Build-time script that extracts AutoDoc from Pike's stdlib,
 * renders XML to markdown, and outputs a JSON index.
 *
 * Usage: bun run scripts/build-stdlib-index.ts
 *
 * The output is committed as server/src/data/stdlib-autodoc.json — it backs
 * stdlib completion and hover. Regenerating is safe: the script refuses to write
 * an index that lost symbols relative to the committed one (pass --force to
 * override).
 */
import { execFileSync } from "node:child_process";
import {
  readdirSync,
  statSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join, extname, basename, dirname } from "node:path";
import { renderAutodoc } from "../server/src/features/autodocRenderer";
import { parseXml, type XmlNode } from "../server/src/features/xmlParser";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PIKE_LIB = process.env.PIKE_LIB || "/usr/local/pike/8.0.1116/lib/modules";
const OUTPUT_PATH = join(
  import.meta.dir,
  "..",
  "server",
  "src",
  "data",
  "stdlib-autodoc.json"
);
const TIMEOUT_MS = 10_000;
const SKIP_DIRS = new Set(["test", "tests", "example", "examples", "demo"]);

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

interface SourceFile {
  /** Absolute filesystem path. */
  absPath: string;
  /** Module path derived from location under lib/modules (e.g. "Protocols.HTTP.Session"). */
  modulePath: string;
}

function discoverFiles(rootDir: string): SourceFile[] {
  const results: SourceFile[] = [];
  walk(rootDir, "");
  return results;

  function walk(dir: string, relPrefix: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = entry.name;

      if (entry.isDirectory()) {
        // Skip test/example/demo directories
        if (SKIP_DIRS.has(name)) continue;
        // .pmod directories are module containers — recurse
        if (name.endsWith(".pmod")) {
          const modSeg = name.replace(/\.pmod$/, "");
          walk(join(dir, name), relPrefix ? `${relPrefix}.${modSeg}` : modSeg);
        } else {
          // Other directories might contain .pike/.pmod files
          walk(join(dir, name), relPrefix);
        }
      } else if (entry.isFile()) {
        // Only .pike and .pmod files (not directories)
        if (name.endsWith(".pike.in")) continue; // template files
        const ext = extname(name);
        if (ext !== ".pike" && ext !== ".pmod") continue;

        const baseName = basename(name, ext);

        // module.pmod / module.pike represents the parent module itself
        if (baseName === "module") {
          // relPrefix already carries the module path
          if (relPrefix) {
            results.push({ absPath: join(dir, name), modulePath: relPrefix });
          }
        } else {
          const mp = relPrefix ? `${relPrefix}.${baseName}` : baseName;
          results.push({ absPath: join(dir, name), modulePath: mp });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// AutoDoc extraction via Pike
// ---------------------------------------------------------------------------

function extractAutodoc(filePath: string): string | null {
  const pikeCode = `object ns = Tools.AutoDoc.PikeExtractor.extractNamespace(Stdio.read_file(${JSON.stringify(filePath)}), ${JSON.stringify(filePath)}, "predef", Tools.AutoDoc.FLAG_KEEP_GOING); if(ns) write(ns->xml());`;
  try {
    const stdout = execFileSync("pike", ["-e", pikeCode], {
      timeout: TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024, // 20 MB
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const trimmed = stdout.trim();
    if (!trimmed || !trimmed.startsWith("<")) return null;
    return trimmed;
  } catch {
    // Timeout, crash, or no output — skip
    return null;
  }
}

// ---------------------------------------------------------------------------
// XML tree walk — extract documented symbols with FQNs
// ---------------------------------------------------------------------------

interface SymbolEntry {
  /** Fully-qualified name (e.g. "predef.Stdio.FILE.read"). */
  fqn: string;
  /** Local name used by renderAutodoc to find the docgroup (e.g. "read"). */
  localName: string;
}

/**
 * Walk the XML tree and collect all documented symbols.
 * Tracks class nesting to build fully-qualified names.
 */
function collectSymbols(
  root: XmlNode,
  modulePath: string,
): SymbolEntry[] {
  const results: SymbolEntry[] = [];
  const prefix = `predef.${modulePath}`;

  // Root may be <namespace> directly, or contain a <namespace> child
  let ns: XmlNode | null = null;
  if (root.tag === "namespace") {
    ns = root;
  } else {
    ns = findChild(root, "namespace");
  }
  if (!ns) return results;

  // Walk namespace children
  walkChildren(ns, prefix);
  return results;

  function walkChildren(node: XmlNode, currentPrefix: string): void {
    if (node.type !== "element" || !node.children) return;

    for (const child of node.children) {
      if (child.type !== "element") continue;

      if (child.tag === "docgroup") {
        const homogenName = child.attrs?.["homogen-name"];
        if (homogenName) {
          results.push({
            fqn: `${currentPrefix}.${homogenName}`,
            localName: homogenName,
          });
        }
      } else if (child.tag === "class") {
        const className = child.attrs?.["name"];
        if (className) {
          // Class itself can have docs
          const hasDoc = (child.children ?? []).some(
            (c) => c.type === "element" && c.tag === "doc",
          );
          if (hasDoc) {
            results.push({
              fqn: `${currentPrefix}.${className}`,
              localName: className,
            });
          }
          // Recurse into class for its members
          walkChildren(child, `${currentPrefix}.${className}`);
        }
      } else if (child.tag === "enum") {
        const enumName = child.attrs?.["name"];
        if (enumName) {
          results.push({
            fqn: `${currentPrefix}.${enumName}`,
            localName: enumName,
          });
        }
      }
    }
  }
}

function findChild(node: XmlNode, tag: string): XmlNode | null {
  if (node.type !== "element" || !node.children) return null;
  for (const child of node.children) {
    if (child.type === "element" && child.tag === tag) return child;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  console.log("Discovering stdlib files...");

  const files = discoverFiles(PIKE_LIB);
  console.log(`Found ${files.length} source files.`);

  // Ensure output directory exists
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });

  const index: Record<string, { signature: string; markdown: string }> = {};
  let filesWithDocs = 0;
  let totalSymbols = 0;
  let errors = 0;

  for (let i = 0; i < files.length; i++) {
    const { absPath, modulePath } = files[i];
    const progress = `[${i + 1}/${files.length}]`;
    process.stdout.write(`${progress} ${modulePath}... `);

    const xml = extractAutodoc(absPath);
    if (!xml) {
      console.log("(no XML)");
      continue;
    }

    // Parse to discover symbols
    const tree = parseXml(xml);
    const symbols = collectSymbols(tree, modulePath);
    if (symbols.length === 0) {
      console.log("(no symbols)");
      continue;
    }

    filesWithDocs++;

    // Render each symbol
    for (const sym of symbols) {
      const rendered = renderAutodoc(xml, sym.localName);
      if (rendered) {
        index[sym.fqn] = {
          signature: rendered.signature,
          markdown: rendered.markdown,
        };
        totalSymbols++;
      }
    }

    console.log(`${symbols.length} symbols`);
  }

  // Refuse to silently shrink the index.
  //
  // This script once dropped every doc-only symbol (335 of them) because
  // renderAutodoc bailed on an empty signature list. Nothing noticed: the
  // script is not run in CI, and a smaller index just means quieter hovers.
  // Losing symbols is always a bug in the extractor, never an intended edit —
  // so say so and stop, rather than overwrite good data with less of it.
  // Pass --force to override (e.g. when Pike itself genuinely lost a module).
  const force = process.argv.includes("--force");
  if (existsSync(OUTPUT_PATH)) {
    const previous = JSON.parse(readFileSync(OUTPUT_PATH, "utf-8")) as Record<string, unknown>;
    const lost = Object.keys(previous).filter((fqn) => !(fqn in index));
    if (lost.length > 0) {
      console.error(
        `\nrefusing to write: ${lost.length} symbol(s) present in the existing ` +
        `index are missing from this run, e.g. ${lost.slice(0, 5).join(", ")}`,
      );
      if (!force) {
        console.error("re-run with --force if this loss is intended.");
        process.exit(1);
      }
      console.error("--force given; writing anyway.");
    }
  }

  // Write JSON
  const json = JSON.stringify(index, null, 2);
  writeFileSync(OUTPUT_PATH, json, "utf-8");

  const jsonSize = Buffer.byteLength(json, "utf-8");
  const sizeStr =
    jsonSize > 1024 * 1024
      ? `${(jsonSize / (1024 * 1024)).toFixed(1)} MB`
      : `${(jsonSize / 1024).toFixed(1)} KB`;

  console.log("\n--- Summary ---");
  console.log(`Files processed: ${files.length}`);
  console.log(`Files with docs: ${filesWithDocs}`);
  console.log(`Symbols indexed: ${totalSymbols}`);
  console.log(`Errors/skipped: ${errors}`);
  console.log(`JSON size: ${sizeStr} (${OUTPUT_PATH})`);
}

main();
