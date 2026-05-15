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
} from "./completion-items";
import type { CompletionContext } from "./completionTrigger";

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
  if (localDecl && (localDecl.kind === "function" || localDecl.kind === "method") && localDecl.declaredType) {
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
  const importDecls = table.declarations.filter(d => d.kind === "inherit" || d.kind === "import");
  for (const importDecl of importDecls) {
    const targetUri = await ctx.index.resolveInherit(importDecl.name, false, ctx.uri);
    if (!targetUri) continue;
    const targetTable = ctx.index.getSymbolTable(targetUri);
    if (!targetTable) continue;
    const fileScope = targetTable.scopes.find(s => s.kind === "file");
    if (!fileScope) continue;
    const importedDecls = getDeclarationsInScope(targetTable, fileScope.id);
    const funcDecl = importedDecls.find(d => d.name === calleeName && (d.kind === "function" || d.kind === "method"));
    if (funcDecl && funcDecl.declaredType) {
      const params = extractParamsFromType(funcDecl.declaredType);
      if (params !== null) {
        return [makeArgSnippet(calleeName, params, funcDecl.declaredType)];
      }
    }
    // Also check class constructors in imported modules
    const classDecl = importedDecls.find(d => d.name === calleeName && d.kind === "class");
    if (classDecl) {
      const createParams = extractConstructorParams(classDecl, targetTable);
      if (createParams !== null) {
        return [makeArgSnippet(calleeName, createParams, "constructor")];
      }
    }
  }

  // 5. Stdlib lookup — search all stdlib entries for matching function name
  for (const [fqn, entry] of Object.entries(ctx.stdlibIndex)) {
    // fqn is like "predef.Module.method" — check last segment
    const parts = fqn.split(".");
    const lastName = parts[parts.length - 1];
    if (lastName !== calleeName) continue;
    // Skip class/module entries (they have "inherit" signatures)
    if (entry.signature.startsWith("inherit")) continue;
    const params = extractParamsFromStdlibSignature(entry.signature);
    if (params !== null) {
      return [makeArgSnippet(calleeName, params, entry.signature)];
    }
  }

  // No resolution found — return empty so no completion dropdown appears.
  return [];
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
