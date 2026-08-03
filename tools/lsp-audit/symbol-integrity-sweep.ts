#!/usr/bin/env bun
/**
 * Integrity oracle for textDocument/documentSymbol and textDocument/references.
 *
 * Both features hand the editor positions, so both can be checked the same way
 * go-to-definition was — against the text actually at those positions. No Pike
 * oracle and no snapshots needed.
 *
 * documentSymbol invariants:
 *   1. selectionRange must sit on the symbol's own name.
 *   2. selectionRange must be contained in range.
 *   3. a child's range must be contained in its parent's range.
 *   4. every range must be inside the document.
 *
 * references invariants (these drive rename — a wrong location here rewrites
 * the wrong token):
 *   5. every returned location's text must be the identifier that was asked
 *      about.
 *   6. the declaration's own location must not be reported twice.
 *   7. COMPLETENESS: every same-file reference the server's own symbol table
 *      resolves to that declaration must be returned. Under-reporting here is
 *      invisible in the editor and silently leaves occurrences behind on a
 *      rename, which is worse than a visible failure.
 *
 * documentSymbol completeness:
 *   8. every top-level declaration in the symbol table must appear somewhere
 *      in the symbol tree, or the outline is lying about the file.
 *
 * Usage: bun run tools/lsp-audit/symbol-integrity-sweep.ts [--root <dir>]
 *                                                         [--refs-per-file N]
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createTestServer, waitForFileEntry } from "../../tests/lsp/helpers";
import { initParser, parse } from "../../server/src/parser";
import { buildSymbolTable } from "../../server/src/features/symbolTable";
import { decodeSource } from "../../server/src/util/sourceDecoder";

interface Pos { line: number; character: number }
interface Range { start: Pos; end: Pos }
interface DocSymbol {
  name: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: DocSymbol[];
}
interface Location { uri: string; range: Range }

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function pikeFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".")) continue;
      const path = join(dir, entry);
      let isDir = false;
      try { isDir = statSync(path).isDirectory(); } catch { continue; }
      if (isDir) walk(path);
      else if (/\.(pike|pmod|h)$/.test(entry)) found.push(path);
    }
  };
  walk(root);
  return found.sort();
}

const lineCache = new Map<string, string[] | null>();
function linesOf(uri: string): string[] | null {
  if (lineCache.has(uri)) return lineCache.get(uri)!;
  let value: string[] | null = null;
  try { value = decodeSource(readFileSync(fileURLToPath(uri))).text.split("\n"); } catch { /* ignore */ }
  lineCache.set(uri, value);
  return value;
}

function inside(outer: Range, inner: Range): boolean {
  if (inner.start.line < outer.start.line || inner.end.line > outer.end.line) return false;
  if (inner.start.line === outer.start.line && inner.start.character < outer.start.character) return false;
  if (inner.end.line === outer.end.line && inner.end.character > outer.end.character) return false;
  return true;
}

const findings = new Map<string, number>();
const examples = new Map<string, string[]>();
function report(kind: string, detail: string) {
  findings.set(kind, (findings.get(kind) ?? 0) + 1);
  const ex = examples.get(kind) ?? [];
  if (ex.length < 8) { ex.push(detail); examples.set(kind, ex); }
}

/** Walk a documentSymbol tree, checking every invariant. */
function checkSymbols(
  rel: string, lines: string[], symbols: DocSymbol[], parent: DocSymbol | null,
): number {
  let n = 0;
  for (const sym of symbols) {
    n++;
    const at = `${rel}:${sym.selectionRange.start.line + 1} "${sym.name}"`;

    if (sym.range.start.line >= lines.length || sym.range.end.line >= lines.length) {
      report("symbol range outside the document", `${at} range ends line ${sym.range.end.line}, file has ${lines.length}`);
    } else {
      const line = lines[sym.selectionRange.start.line];
      const got = line?.slice(sym.selectionRange.start.character, sym.selectionRange.end.character);
      // Pike writes operator members as `` `+ `` and getters as `` `x ``; the
      // symbol name and the written token legitimately differ there.
      if (got !== sym.name && !sym.name.startsWith("`") && !/^["'`]/.test(got ?? "")) {
        report("selectionRange is not on the symbol's name",
          `${at} selectionRange holds ${JSON.stringify(got)}`);
      }
      if (!inside(sym.range, sym.selectionRange)) {
        report("selectionRange not contained in range", at);
      }
    }

    if (parent && !inside(parent.range, sym.range)) {
      report("child symbol escapes its parent's range", `${at} parent "${parent.name}"`);
    }

    if (sym.children?.length) n += checkSymbols(rel, lines, sym.children, sym);
  }
  return n;
}

async function main(): Promise<void> {
  const root = resolve(flag("root", "corpus/files"));
  const refsPerFile = Number(flag("refs-per-file", "12"));
  await initParser();

  const files = pikeFiles(root);
  console.error(`sweeping ${files.length} files under ${root}`);

  const server = await createTestServer({ rootUri: pathToFileURL(root).href });
  const uris: string[] = [];
  for (const path of files) {
    try {
      const text = decodeSource(readFileSync(path)).text;
      server.openDoc(pathToFileURL(path).href, text);
      uris.push(pathToFileURL(path).href);
    } catch { /* unreadable */ }
  }
  try { await waitForFileEntry(server, uris, 120_000); }
  catch (err) { console.error(`warning: ${(err as Error).message}`); }

  const symbolTrees = new Map<string, DocSymbol[]>();
  let symbolCount = 0;
  let refRequests = 0;
  let refLocations = 0;

  for (const path of files) {
    const uri = pathToFileURL(path).href;
    let text: string;
    try { text = decodeSource(readFileSync(path)).text; } catch { continue; }
    const rel = path.replace(root + "/", "");
    const lines = text.split("\n");

    // --- documentSymbol ---
    try {
      const symbols = await server.client.sendRequest("textDocument/documentSymbol", {
        textDocument: { uri },
      }) as DocSymbol[] | null;
      if (symbols) {
        symbolCount += checkSymbols(rel, lines, symbols, null);
        symbolTrees.set(rel, symbols);
      }
    } catch (err) {
      report("documentSymbol request failed", `${rel}: ${(err as Error).message}`);
    }

    // --- references, anchored at declarations (the realistic user action) ---
    const tree = parse(text, uri);
    if (!tree) continue;
    const table = buildSymbolTable(tree, uri, 1, undefined, text);

    // Outline completeness: a file-scope declaration missing from the tree is
    // a symbol the user cannot navigate to in the outline or Ctrl+Shift+O.
    const outline = symbolTrees.get(rel);
    if (outline) {
      const named = new Set<string>();
      const collect = (list: DocSymbol[]) => {
        for (const sy of list) { named.add(sy.name); if (sy.children) collect(sy.children); }
      };
      collect(outline);
      const fileScope = table.scopes.find(sc => sc.kind === "file");
      for (const id of fileScope?.declarations ?? []) {
        const d = table.declById.get(id);
        if (!d) continue;
        if (d.kind === "import" || d.kind === "inherit" || d.kind === "include") continue;
        // Macros are not Pike symbols: they are gone by compile time, Pike's
        // introspection does not list them, and the same name can be defined
        // once per #ifdef branch. The outline omits them on purpose.
        if (d.kind === "macro") continue;
        if (d.name.startsWith("`") || d.name.startsWith('"')) continue;
        if (!named.has(d.name)) {
          report("file-scope declaration missing from the outline",
            `${rel} ${d.kind} "${d.name}"@${d.nameRange.start.line + 1}`);
        }
      }
    }
    const targets = table.declarations
      .filter(d => d.kind === "function" || d.kind === "method" || d.kind === "variable")
      .filter(d => !d.name.startsWith("`") && !d.name.startsWith('"'))
      .slice(0, refsPerFile);

    for (const decl of targets) {
      refRequests++;
      let locs: Location[] | null;
      try {
        locs = await server.client.sendRequest("textDocument/references", {
          textDocument: { uri },
          position: {
            line: decl.nameRange.start.line,
            character: decl.nameRange.start.character,
          },
          context: { includeDeclaration: true },
        }) as Location[] | null;
      } catch (err) {
        report("references request failed", `${rel} "${decl.name}": ${(err as Error).message}`);
        continue;
      }
      if (!locs) continue;

      const seen = new Set<string>();
      for (const loc of locs) {
        refLocations++;
        const targetLines = linesOf(loc.uri);
        if (!targetLines) {
          report("reference in an unreadable file", `${rel} "${decl.name}" -> ${loc.uri}`);
          continue;
        }
        if (loc.range.start.line >= targetLines.length) {
          report("reference line outside its file",
            `${rel} "${decl.name}" -> ${loc.uri.split("/").pop()}:${loc.range.start.line + 1} (file has ${targetLines.length})`);
          continue;
        }
        const line = targetLines[loc.range.start.line];
        const got = line.slice(loc.range.start.character, loc.range.end.character);
        if (got !== decl.name) {
          report("reference does not point at the identifier",
            `${rel} "${decl.name}" -> ${loc.uri.split("/").pop()}:${loc.range.start.line + 1} holds ${JSON.stringify(got)}`);
        }
        const key = `${loc.uri}:${loc.range.start.line}:${loc.range.start.character}`;
        if (seen.has(key)) {
          report("duplicate reference location",
            `${rel} "${decl.name}" -> ${loc.uri.split("/").pop()}:${loc.range.start.line + 1}`);
        }
        seen.add(key);
      }

      // Completeness against the server's own symbol table: every in-file
      // reference bound to this declaration must come back.
      for (const ref of table.references) {
        if (ref.resolvesTo !== decl.id) continue;
        const key = `${uri}:${ref.loc.line}:${ref.loc.character}`;
        if (!seen.has(key)) {
          report("MISSING reference the symbol table resolves to this declaration",
            `${rel} "${decl.name}" missing ${ref.name}@${ref.loc.line + 1}:${ref.loc.character}`);
        }
      }
    }
  }

  await server.teardown();

  console.log(`\ndocumentSymbol: ${symbolCount} symbols checked`);
  console.log(`references    : ${refRequests} requests, ${refLocations} locations checked`);
  const total = [...findings.values()].reduce((a, b) => a + b, 0);
  console.log(`\nFINDINGS: ${total}`);
  for (const [kind, n] of [...findings.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`\n${String(n).padStart(6)}  ${kind}`);
    for (const e of examples.get(kind) ?? []) console.log(`          ${e}`);
  }
  const out = flag("dump", "");
  if (out) writeFileSync(out, JSON.stringify([...findings], null, 2));
}

await main();
