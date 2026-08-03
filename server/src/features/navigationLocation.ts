/**
 * The one place a declaration becomes an LSP Location.
 *
 * Shared by navigationGoTo.ts and navigationModuleTarget.ts so a change to the
 * shape cannot drift between them.
 */

import type { Location as LspLocation } from "vscode-languageserver/node";

/** Convert a declaration to an LSP Location. */
export function declToLspLocation(
  uri: string,
  decl: { nameRange: { start: { line: number; character: number }; end: { line: number; character: number } } },
): LspLocation {
  return {
    uri,
    range: {
      start: { line: decl.nameRange.start.line, character: decl.nameRange.start.character },
      end: { line: decl.nameRange.end.line, character: decl.nameRange.end.character },
    },
  };
}
