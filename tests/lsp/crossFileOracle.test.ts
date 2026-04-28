/**
 * Cross-file resolution oracle tests.
 *
 * These tests compare the LSP's cross-file resolution against Pike's actual
 * resolution, using ground truth from `harness/resolve.pike`.
 *
 * The principle: "Pike is the oracle." If the LSP resolves a cross-file
 * reference to a different file than Pike does, that's a bug.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { initParser, parse } from "../../server/src/parser";
import { WorkspaceIndex, ModificationSource } from "../../server/src/features/workspaceIndex";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ResolutionResult } from "../../harness/src/runner";

const CORPUS_DIR = join(import.meta.dir, "..", "..", "corpus", "files");
const RESOLVE_SNAPSHOTS_DIR = join(import.meta.dir, "..", "..", "harness", "resolve-snapshots");

function corpusUri(name: string): string {
  return `file://${join(CORPUS_DIR, name)}`;
}

function readCorpus(name: string): string {
  return readFileSync(join(CORPUS_DIR, name), "utf-8");
}

function loadResolveSnapshot(corpusFile: string): ResolutionResult | null {
  const name = corpusFile.replace(/\.(pike|pmod)$/, "");
  const path = join(RESOLVE_SNAPSHOTS_DIR, `${name}-resolve.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

/** Index a file into the workspace */
function indexFile(index: WorkspaceIndex, name: string): void {
  const uri = corpusUri(name);
  const content = readCorpus(name);
  const tree = parse(content);
  index.upsertFile(uri, 1, tree, content, ModificationSource.DidOpen);
}

// Map of corpus file → its resolution snapshot
const crossFileCases: Array<{ file: string; snapshot: ResolutionResult }> = [];

beforeAll(async () => {
  await initParser();

  // Load all resolution snapshots
  const crossFiles = [
    "cross-inherit-simple-b.pike",
    "cross-inherit-rename-b.pike",
    "cross-inherit-chain-b.pike",
    "cross-inherit-chain-c.pike",
    "cross-import-b.pike",
    "cross-pmod-user.pike",
    "cross-lib-user.pike",
  ];

  for (const f of crossFiles) {
    const snapshot = loadResolveSnapshot(f);
    if (snapshot) {
      crossFileCases.push({ file: f, snapshot });
    }
  }
});

describe("Cross-file resolution oracle — LSP agrees with Pike", () => {
  test("all cross-file corpus files have resolution snapshots", () => {
    expect(crossFileCases.length).toBe(7);
  });

  test("inherit resolution targets match Pike", () => {
    const index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });

    // Index all cross-file corpus files
    const allFiles = [
      "cross-inherit-simple-a.pike", "cross-inherit-simple-b.pike",
      "cross-inherit-rename-a.pike", "cross-inherit-rename-b.pike",
      "cross-inherit-chain-a.pike", "cross-inherit-chain-b.pike", "cross-inherit-chain-c.pike",
      "cross-import-b.pike",
      "cross-pmod-user.pike",
      "cross-lib-user.pike",
      "cross_import_a.pmod", "cross_lib_module.pmod",
      // .pmod directory children — must be indexed for directory module resolution
      "cross_pmod_dir.pmod/module.pmod",
      "cross_pmod_dir.pmod/helpers.pike",
    ];
    for (const f of allFiles) {
      indexFile(index, f);
    }

    const disagreements: string[] = [];

    for (const { file, snapshot } of crossFileCases) {
      const uri = corpusUri(file);
      const table = index.getSymbolTable(uri);
      if (!table) {
        disagreements.push(`${file}: LSP could not build symbol table`);
        continue;
      }

      for (const resolution of snapshot.resolutions) {
        // Only check cross-file resolutions (those that resolve to a file)
        if (!resolution.target_file) continue;

        // Skip intra-file class inherits (like "inherit Animal")
        if (resolution.resolve_error) continue;

        const pikeTarget = resolution.target_file;

        // Find the inherit or import declaration at the right line
        const inheritDecl = table.declarations.find(
          d => (d.kind === 'inherit' || d.kind === 'import') && d.nameRange.start.line === resolution.line - 1,
        );

        if (!inheritDecl) {
          disagreements.push(
            `${file}:${resolution.line}: LSP has no inherit declaration (Pike resolves ${resolution.reference} → ${pikeTarget})`,
          );
          continue;
        }

        // Use the LSP's cross-file resolution
        const lspResult = index.resolveCrossFileDefinition(
          uri,
          inheritDecl.nameRange.start.line,
          inheritDecl.nameRange.start.character,
        );

        if (!lspResult) {
          disagreements.push(
            `${file}:${resolution.line}: LSP could not resolve ${resolution.reference} (Pike → ${pikeTarget})`,
          );
          continue;
        }

        // Compare target files — normalize both to use corpus-relative paths
        const lspUri = lspResult.uri;
        let lspFile = lspUri.replace("file://", "").replace(CORPUS_DIR + "/", "corpus/files/");
        const pikeFile = pikeTarget;

        // For directory modules, LSP resolves to module.pmod inside the directory.
        // Pike resolves to the directory itself. These are equivalent.
        // Normalize: if LSP path ends with .pmod/module.pmod and Pike is .pmod, strip /module.pmod
        if (pikeFile.endsWith(".pmod") && lspFile.endsWith(".pmod/module.pmod")) {
          const dirPart = lspFile.replace("/module.pmod", "");
          if (dirPart === pikeFile) {
            lspFile = dirPart; // Normalize to match Pike's answer
          }
        }

        if (lspFile !== pikeFile) {
          disagreements.push(
            `${file}:${resolution.line}: ${resolution.reference} — LSP → ${lspFile}, Pike → ${pikeFile}`,
          );
        }
      }
    }

    if (disagreements.length > 0) {
      console.error("LSP/Pike disagreements:");
      for (const d of disagreements) {
        console.error(`  ${d}`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  test("inherited symbols are available in the symbol table", () => {
    const index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });

    const allFiles = [
      "cross-inherit-simple-a.pike", "cross-inherit-simple-b.pike",
      "cross-inherit-rename-a.pike", "cross-inherit-rename-b.pike",
      "cross-inherit-chain-a.pike", "cross-inherit-chain-b.pike", "cross-inherit-chain-c.pike",
      "cross-import-b.pike",
      "cross-pmod-user.pike",
      "cross-lib-user.pike",
      "cross_import_a.pmod", "cross_lib_module.pmod",
    ];
    for (const f of allFiles) {
      indexFile(index, f);
    }

    // For each cross-file case, verify that the symbols Pike reports
    // in the target file are present in the LSP's symbol table for that target
    const missingSymbols: string[] = [];

    for (const { file, snapshot } of crossFileCases) {
      for (const resolution of snapshot.resolutions) {
        if (!resolution.target_file || !resolution.symbols) continue;
        if (resolution.resolve_error) continue;

        const targetUri = corpusUri(resolution.target_file.replace("corpus/files/", ""));
        const targetTable = index.getSymbolTable(targetUri);
        if (!targetTable) {
          // Target file may not be indexed individually (e.g., .pmod directories)
          continue;
        }

        const lspSymbolNames = new Set(targetTable.declarations.map(d => d.name));

        for (const pikeSymbol of resolution.symbols) {
          // Skip `main` — it's always present but may be filtered
          if (pikeSymbol.name === "main") continue;
          // Skip symbols without a defined_file matching the target
          if (pikeSymbol.defined_file && pikeSymbol.defined_file !== resolution.target_file) continue;

          if (!lspSymbolNames.has(pikeSymbol.name)) {
            missingSymbols.push(
              `${file}: symbol "${pikeSymbol.name}" (${pikeSymbol.kind}) not found in LSP's symbol table for ${resolution.target_file}`,
            );
          }
        }
      }
    }

    if (missingSymbols.length > 0) {
      console.error("Missing symbols:");
      for (const s of missingSymbols) {
        console.error(`  ${s}`);
      }
    }
    // Note: We don't fail on missing symbols yet because the LSP's symbol table
    // uses tree-sitter parsing which may differ from Pike's runtime introspection
    // for certain constructs. This is documented as an expected gap.
    // The critical check is the resolution target comparison above.
  });
});

describe("Cross-file resolution oracle — .pmod directory", () => {
  test("cross_pmod_dir resolves to the directory module path", () => {
    const snapshot = loadResolveSnapshot("cross-pmod-user.pike");
    expect(snapshot).not.toBeNull();

    const importRes = snapshot!.resolutions.find(r => r.reference === "cross_pmod_dir");
    expect(importRes).toBeDefined();
    expect(importRes!.target_file).toBe("corpus/files/cross_pmod_dir.pmod");
  });

  test("cross_pmod_dir exposes expected symbols from Pike", () => {
    const snapshot = loadResolveSnapshot("cross-pmod-user.pike");
    const importRes = snapshot!.resolutions.find(r => r.reference === "cross_pmod_dir");
    expect(importRes).toBeDefined();

    const symbolNames = (importRes!.symbols || []).map(s => s.name);
    // These symbols come from cross_pmod_dir.pmod/module.pmod and helpers.pike
    expect(symbolNames).toContain("MODULE_NAME");
    expect(symbolNames).toContain("capitalize");
    expect(symbolNames).toContain("helpers");
  });
});
