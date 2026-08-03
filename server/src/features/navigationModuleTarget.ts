/**
 * Module-path go-to targets: the last-resort tier of textDocument/definition.
 *
 * Split out of navigationGoTo.ts to keep both files under the 500-line limit.
 */

import type { Location as LspLocation } from "vscode-languageserver/node";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { NavigationContext } from "./navigationHandler";
import { isWrittenInFile, type SymbolTable } from "./symbolTable";
import { modulePathAtPosition } from "./accessResolver";
import { refineRuntimeTarget } from "./runtimeTargetRefine";
import { declToLspLocation } from "./navigationLocation";

/**
 * Last-resort definition targets the earlier tiers cannot see:
 * - an inherit alias (`base` in `base::create()`) → the inherit declaration;
 * - a module/type path segment (`Util` in `.Util.double_it`, `Stdio` in
 *   `Stdio.File`) → the module's file;
 * - a stdlib class path (`String.Buffer`) → the source location the Pike
 *   worker's runtime resolve reports.
 */
export async function resolveModulePathTarget(
  ctx: NavigationContext,
  table: SymbolTable,
  doc: { getText(): string } | undefined,
  params: { textDocument: { uri: string }; position: { line: number; character: number } },
): Promise<LspLocation | null> {
  if (!doc) return null;
  const lines = doc.getText().split('\n');
  const path = modulePathAtPosition(lines, params.position.line, params.position.character);
  if (!path) return null;

  // Inherit alias: jump to the inherit declaration that binds it.
  //
  // Land on the alias, not on the path it renames. `inherit Parser.HTML:
  // low_parser;` declares `low_parser` and declares nothing called
  // `Parser.HTML` — answering the path put the cursor on a different symbol on
  // the right line. This is the rule the rest of the query layer already
  // follows (see declOccurrenceRangeAt).
  if (!path.includes(".")) {
    const aliasDecl = table.declarations.find(
      d => d.kind === "inherit" && d.alias === path && isWrittenInFile(table, d),
    );
    if (aliasDecl) {
      const range = aliasDecl.aliasRange ?? aliasDecl.nameRange;
      return declToLspLocation(table.uri, { nameRange: range });
    }
  }

  const moduleUri = await ctx.index.resolveModule(path, params.textDocument.uri);
  // Directory modules without a module.pmod resolve to the directory itself,
  // which an editor cannot open — skip those.
  if (moduleUri && !moduleUri.endsWith("/")) {
    return {
      uri: moduleUri,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    };
  }

  // Stdlib class the filesystem walk cannot reach (a class inside a file
  // module, e.g. String.Buffer): the worker's introspection knows its source.
  // C-implemented symbols report the path Pike was BUILT from (a foreign
  // machine), so only offer the target when the file exists here.
  if (!path.startsWith(".") && path.includes(".") && ctx.worker) {
    try {
      const resolved = await ctx.worker.resolve(path);
      if (resolved.resolved && resolved.source_file && existsSync(resolved.source_file)) {
        const line = Math.max(0, (resolved.source_line ?? 1) - 1);
        // The runtime reports a line and no column, and its line is often the
        // `{` below the header rather than the header itself. Pin the name's
        // real position when it is nearby; when it is not, offer the top of
        // the file rather than a brace that is not the definition.
        const tail = path.split(".").filter(s => s.length > 0).pop() ?? path;
        const exact = await refineRuntimeTarget(resolved.source_file, line, tail);
        const start = exact ?? { line: 0, character: 0 };
        const end = exact
          ? { line: exact.line, character: exact.character + tail.length }
          : { line: 0, character: 0 };
        return {
          uri: pathToFileURL(resolved.source_file).href,
          range: { start, end },
        };
      }
    } catch { /* Worker unavailable — no target */ }
  }

  return null;
}

