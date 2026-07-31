/**
 * Hover on a dotted type/module path — `Stdio.File`, `.Util`, `Image`.
 *
 * Split out of hoverHandler.ts at the 500-line TigerStyle limit. Runs with the
 * other path-aware tiers, ahead of everything that answers by bare name: a
 * qualified name and a bare one are different symbols.
 */

import type { Hover } from "vscode-languageserver/node";
import { formatHover } from "./hoverContent";
import { modulePathAtPosition, headOfDottedPath } from "./accessResolver";
import type { HoverContext } from "./hoverHandler";

/**
 * Hover on a dotted type/module path — `Stdio.File` in a declaration, or a
 * relative module reference like `.Util`. Tries the static stdlib index
 * (rich class docs), then the workspace module resolver, then the Pike
 * worker's runtime resolve for stdlib types the index doesn't carry
 * (e.g. `String.Buffer`).
 */
export async function hoverFromModulePath(
  ctx: HoverContext,
  doc: { getText(): string },
  params: { textDocument: { uri: string }; position: { line: number; character: number } },
): Promise<Hover | null> {
  const lines = doc.getText().split('\n');
  const path = modulePathAtPosition(lines, params.position.line, params.position.character);
  if (!path) return null;

  // The bundled Roxen API is dotted too, but it is consulted before the
  // bare-name tiers rather than here — see roxenPathHover.

  // Static stdlib entry: class/module docs. Signatures are empty for class
  // entries (`predef.Stdio.File`), so synthesize a readable header.
  if (!path.startsWith(".")) {
    const entry = ctx.stdlibIndex[`predef.${path}`];
    if (entry) {
      return formatHover({
        name: path,
        signature: entry.signature || `class ${path}`,
        documentation: entry.markdown,
        line: params.position.line,
        character: params.position.character,
        isAutodoc: true,
      });
    }
  }

  // Workspace module (including Pike's relative `.Util` form).
  const moduleUri = await ctx.index.resolveModule(path, params.textDocument.uri);
  if (moduleUri) {
    const basename = moduleUri.replace(/\/+$/, "").split("/").pop() ?? moduleUri;
    return formatHover({
      name: path,
      signature: `module ${path}`,
      documentation: `Defined in \`${basename}\``,
      line: params.position.line,
      character: params.position.character,
    });
  }

  // Runtime resolve: stdlib modules and types absent from the static index.
  //
  // A BARE name qualifies when the source has it followed by a `.`, which
  // makes it the head of a module path rather than a local. `Image` is
  // installed as `Image.so` — a compiled C module with no `.pmod` on disk for
  // the resolver above to find — so it hovered as nothing at 272 positions in
  // Roxen 6.1 while `Stdio` and `ADT`, which ship as directories, answered.
  // Without the trailing-dot test every unresolved identifier in the file
  // would cost a worker round-trip.
  const isModuleHead = /^[A-Za-z_][A-Za-z0-9_]*$/.test(path) &&
    headOfDottedPath(lines, params.position.line, path);
  if (process.env.PIKE_LSP_DIAG === "1") {
    console.error(`[DIAG] hoverModulePath path=${JSON.stringify(path)} isModuleHead=${isModuleHead} line=${params.position.line} ch=${params.position.character}`);
  }
  if (!path.startsWith(".") && (path.includes(".") || isModuleHead)) {
    try {
      const resolved = await ctx.worker.resolve(path);
      if (process.env.PIKE_LSP_DIAG === "1") {
        console.error(`[DIAG] worker.resolve(${JSON.stringify(path)}) => ${JSON.stringify(resolved)}`);
      }
      if (resolved.resolved && resolved.kind) {
        return formatHover({
          name: path,
          signature: `${resolved.kind} ${path}`,
          documentation: "",
          line: params.position.line,
          character: params.position.character,
        });
      }
    } catch { /* Worker unavailable — no hover */ }
  }

  return null;
}
