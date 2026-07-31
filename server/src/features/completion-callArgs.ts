// ---------------------------------------------------------------------------
// completion-callArgs.ts: Call-args completion (triggered by '(' after a function name)
// Extracted from completion.ts to reduce file size.
// ---------------------------------------------------------------------------
import { Tree } from "web-tree-sitter";
import {
  CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
} from "vscode-languageserver/node";
import type { SymbolTable } from "./symbolTable";
import { getDeclarationsInScope } from "./symbolTable";
import {
  findDeclarationForName,
  cleanPredefSignature,
  extractParamsFromPredefType,
  extractParamsFromStdlibSignature,
  extractConstructorParams,
  extractParamsFromType,
  extractParamsFromDecl,
} from "./completion-items";
import type { CompletionContext } from "./completionTrigger";
import { getStdlibEntriesByName } from "./completion-stdlib";

// ---------------------------------------------------------------------------
// Call-args completion
// ---------------------------------------------------------------------------

/**
 * When the user types `funcName(`, offer a single completion item that
 * inserts argument placeholders with tab stops. This gives "type `(` and
 * get prompted with args" behavior.
 *
 * Resolution chain: local scope → imports → predef → stdlib → class constructors.
 */
export async function completeCallArgs(
  table: SymbolTable,
  tree: Tree,
  line: number,
  character: number,
  calleeName: string,
  ctx: CompletionContext,
): Promise<CompletionItem[]> {
  // 1. Local/inner-function lookup
  const localDecl = findDeclarationForName(table, calleeName, line, character);
  if (localDecl && (localDecl.kind === "function" || localDecl.kind === "method")) {
    // Parameters first: a function declaration's declaredType is its return
    // type, so the type route below only fires for a variable holding a
    // function type.
    const fromScope = extractParamsFromDecl(localDecl, table);
    if (fromScope !== null) {
      return [makeArgSnippet(calleeName, fromScope, localDecl.declaredType ?? "function")];
    }
    if (localDecl.declaredType) {
      const params = extractParamsFromType(localDecl.declaredType);
      if (params !== null) {
        return [makeArgSnippet(calleeName, params, localDecl.declaredType)];
      }
    }
  }

  // A variable holding a function type is callable too.
  if (localDecl && (localDecl.kind === "variable" || localDecl.kind === "parameter") && localDecl.declaredType) {
    const params = extractParamsFromType(localDecl.declaredType);
    if (params !== null) {
      return [makeArgSnippet(calleeName, params, localDecl.declaredType)];
    }
  }

  // 2. Class constructor lookup (same file)
  if (localDecl && localDecl.kind === "class") {
    const createParams = extractConstructorParams(localDecl, table);
    if (createParams !== null) {
      return [makeArgSnippet(calleeName, createParams, "constructor")];
    }
  }

  // 3. Predef builtins
  const predefSig = ctx.predefBuiltins[calleeName];
  if (predefSig) {
    const params = extractParamsFromPredefType(predefSig);
    if (params !== null) {
      return [makeArgSnippet(calleeName, params, cleanPredefSignature(predefSig))];
    }
  }

  // 4. Cross-file: check imports for the function
  const importResult = await lookupImportedCallable(table, ctx, calleeName);
  if (importResult) return importResult;

  // 5. Stdlib lookup — O(1) reverse index by unqualified name
  const stdlibMatches = getStdlibEntriesByName(ctx.stdlibIndex, calleeName);
  if (stdlibMatches) {
    for (const { entry } of stdlibMatches) {
      // Skip class/module entries (they have "inherit" signatures)
      if (entry.signature.startsWith("inherit")) continue;
      const params = extractParamsFromStdlibSignature(entry.signature);
      if (params !== null) {
        return [makeArgSnippet(calleeName, params, entry.signature)];
      }
    }
  }

  // No resolution found — return empty so no completion dropdown appears.
  return [];
}

// -----------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------

/** Look up a callable (function/method/class constructor) in imported modules. */
async function lookupImportedCallable(
  table: SymbolTable,
  ctx: CompletionContext,
  calleeName: string,
): Promise<CompletionItem[] | null> {
  const importDecls = table.declarations.filter(d => d.kind === "inherit" || d.kind === "import");
  for (const importDecl of importDecls) {
    const targetUri = await ctx.index.resolveInherit(importDecl.name, false, ctx.uri);
    if (!targetUri) continue;
    // getOrIndex: hydrate a lazily-restored stub target on first access.
    const targetTable = await ctx.index.getOrIndexSymbolTable(targetUri);
    if (!targetTable) continue;
    const fileScope = targetTable.scopes.find(s => s.kind === "file");
    if (!fileScope) continue;
    const importedDecls = getDeclarationsInScope(targetTable, fileScope.id);

    // Single pass: check function/method AND class constructor
    const funcDecl = importedDecls.find(d => d.name === calleeName && (d.kind === "function" || d.kind === "method"));
    if (funcDecl && funcDecl.declaredType) {
      const params = extractParamsFromType(funcDecl.declaredType);
      if (params !== null) return [makeArgSnippet(calleeName, params, funcDecl.declaredType)];
    }
    const classDecl = importedDecls.find(d => d.name === calleeName && d.kind === "class");
    if (classDecl) {
      const createParams = extractConstructorParams(classDecl, targetTable);
      if (createParams !== null) return [makeArgSnippet(calleeName, createParams, "constructor")];
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a single completion item that inserts argument placeholders.
 * The item is meant to be accepted immediately after the user types '('.
 *
 * newText inserts the args and closing paren, with $0 exit cursor after.
 */
function makeArgSnippet(name: string, params: string, detail: string): CompletionItem {
  return {
    label: params.length > 0 ? `${name}(${params})` : `${name}()`,
    kind: CompletionItemKind.Snippet,
    detail,
    sortText: "0000", // highest priority
    filterText: name,
    insertTextFormat: InsertTextFormat.Snippet,
    // Insert the args + closing paren. The '(' is already typed by the user.
    // Cursor exits after the closing paren via $0.
    insertText: params.length > 0 ? `${params})$0` : `)$0`,
    preselect: true,
  };
}
