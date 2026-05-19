/**
 * Refactoring handlers — rename (prepare + request), codeAction, workspaceSymbol.
 *
 * Extracted from navigationHandler.ts to keep file sizes under 500 lines.
 */

import {
  type Connection,
  type CancellationToken,
  ErrorCodes,
  ResponseError,
} from "vscode-languageserver/node";
import type { NavigationContext } from "./navigationHandler";
import {
  getRenameLocations,
  buildWorkspaceEdit,
  prepareRename,
  validateRenameName,
} from "./rename";
import { produceCodeActions } from "./codeAction";
import { produceAutodocTemplateActions } from "./autodocTemplate";
import { produceGetterSetterActions } from "./getterSetter";
import { searchWorkspaceSymbols } from "./workspaceSymbol";
import stdlibAutodocIndexRaw from "../data/stdlib-autodoc.json";
import predefBuiltinIndexRaw from "../data/predef-builtin-index.json";
import {
  validateStdlibAutodocIndexOrEmpty,
  validatePredefBuiltinIndexOrEmpty,
} from "../util/staticDataValidation.js";

// ---------------------------------------------------------------------------
// Protected names (rename guard)
// ---------------------------------------------------------------------------

const predefBuiltins = validatePredefBuiltinIndexOrEmpty(predefBuiltinIndexRaw);

/**
 * Build the set of protected symbol names that cannot be renamed.
 * Combines predef builtins (283) and unqualified stdlib names (5,471 FQNs).
 */
function buildProtectedNames(
  stdlibAutodoc: Record<string, unknown>,
  predef: Record<string, string>,
): Set<string> {
  const names = new Set<string>();
  // Predef builtins: keys are short names (write, search, etc.)
  for (const name of Object.keys(predef)) {
    names.add(name);
  }
  // Stdlib: keys are FQNs (predef.Array.diff). Extract unqualified name.
  for (const fqn of Object.keys(stdlibAutodoc)) {
    const parts = fqn.split(".");
    const short = parts[parts.length - 1];
    names.add(short);
  }
  return names;
}

const stdlibAutodocValidated = validateStdlibAutodocIndexOrEmpty(stdlibAutodocIndexRaw);

const protectedNames: Set<string> = buildProtectedNames(
  stdlibAutodocValidated,
  predefBuiltins,
);

/**
 * Extract top-level stdlib module names from the autodoc index.
 * Keys are 'predef.Module.Class.method' — we extract the 'Module' segment.
 */
function buildStdlibModules(
  stdlibAutodoc: Record<string, unknown>,
): Set<string> {
  const modules = new Set<string>();
  for (const fqn of Object.keys(stdlibAutodoc)) {
    const parts = fqn.split(".");
    // predef.X.Y... → X is the module name
    if (parts.length >= 2) {
      modules.add(parts[1]);
    }
  }
  return modules;
}

const stdlibModules: Set<string> = buildStdlibModules(
  stdlibAutodocValidated,
);

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register refactoring handlers on the connection.
 */
export function registerRefactoringHandlers(
  connection: Connection,
  ctx: NavigationContext,
): void {
  // -----------------------------------------------------------------------
  // textDocument/codeAction (US-018)
  // -----------------------------------------------------------------------

  connection.onCodeAction(async (params, token: CancellationToken) => {
    if (token.isCancellationRequested) return [];
    const doc = ctx.documents.get(params.textDocument.uri);
    if (!doc) return [];

    const text = doc.getText();
    const diagnosticActions = produceCodeActions(params, text, { stdlibModules });
    const autodocActions = produceAutodocTemplateActions(params, text);
    const getterSetterActions = produceGetterSetterActions(params, text, { stdlibModules });
    return [...diagnosticActions, ...autodocActions, ...getterSetterActions];
  });

  // -----------------------------------------------------------------------
  // workspace/symbol (US-020)
  // -----------------------------------------------------------------------

  connection.onRequest("workspace/symbol", async (params, token: CancellationToken) => {
    if (token.isCancellationRequested) return [];
    const query = params.query ?? "";
    const results = searchWorkspaceSymbols(query, ctx.index);
    return results;
  });

  // -----------------------------------------------------------------------
  // textDocument/rename (decision 0016)
  // -----------------------------------------------------------------------

  connection.onPrepareRename(async (params, token: CancellationToken) => {
    if (token.isCancellationRequested) return null;
    const table = await ctx.getSymbolTable(params.textDocument.uri);
    if (!table) return null;

    const result = prepareRename(
      table,
      params.position.line,
      params.position.character,
      protectedNames,
    );
    if (!result) return null;

    return {
      range: {
        start: {
          line: result.line,
          character: result.character,
        },
        end: {
          line: result.line,
          character: result.character + result.length,
        },
      },
      placeholder: result.name,
    };
  });

  connection.onRenameRequest(async (params, token: CancellationToken) => {
    if (token.isCancellationRequested) return null;
    const table = await ctx.getSymbolTable(params.textDocument.uri);
    if (!table) return null;

    // Validate new name — return a descriptive error, not silent null.
    const validationError = validateRenameName(params.newName);
    if (validationError) {
      return new ResponseError(ErrorCodes.InvalidRequest, validationError);
    }

    const renameResult = await getRenameLocations(
      table,
      params.textDocument.uri,
      params.position.line,
      params.position.character,
      ctx.index,
      protectedNames,
    );

    if (!renameResult) {
      return new ResponseError(
        ErrorCodes.InvalidRequest,
        "No renamable symbol at the given position",
      );
    }

    // Don't rename if old name equals new name
    if (renameResult.oldName === params.newName) {
      return new ResponseError(
        ErrorCodes.InvalidRequest,
        "New name is the same as the current name",
      );
    }

    return buildWorkspaceEdit(renameResult.locations, params.newName);
  });
}
