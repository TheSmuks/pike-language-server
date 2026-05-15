/**
 * Completion item construction and snippet helpers for Pike LSP.
 *
 * Extracted from completionTrigger.ts: functions that convert declarations
 * to LSP CompletionItems, generate snippet placeholders, and process
 * type signatures.
 *
 * Snippet helpers are in completion-snippets.ts and re-exported here.
 */

import { Tree } from "web-tree-sitter";
import {
  CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
} from "vscode-languageserver/node";
import {
  type SymbolTable,
  type Declaration,
  type DeclKind,
  getSymbolsInScope,
  resolveTypeName,
  PRIMITIVE_TYPES,
} from "./symbolTable";
import { resolveType, collectClassMembers } from "./typeResolver";
import type { CompletionContext } from "./completionTrigger";
import {
  extractParamsFromType,
  extractConstructorParams,
  extractParamsFromPredefType,
  extractParamsFromStdlibSignature,
  cleanPredefSignature,
} from "./completion-snippets";
import { utf8ToUtf16 } from "../util/positionConverter";

// Re-export snippet helpers for backward compatibility
export {
  extractParamsFromType,
  extractConstructorParams,
  extractParamsFromPredefType,
  extractParamsFromStdlibSignature,
  cleanPredefSignature,
} from "./completion-snippets";

// ---------------------------------------------------------------------------
// Declaration → CompletionItem
// ---------------------------------------------------------------------------

const DECL_KIND_TO_COMPLETION_KIND: Record<DeclKind, CompletionItemKind> = {
  function: CompletionItemKind.Function,
  method: CompletionItemKind.Method,
  class: CompletionItemKind.Class,
  variable: CompletionItemKind.Variable,
  constant: CompletionItemKind.Constant,
  enum: CompletionItemKind.Enum,
  enum_member: CompletionItemKind.EnumMember,
  typedef: CompletionItemKind.TypeParameter,
  parameter: CompletionItemKind.Variable,
  inherit: CompletionItemKind.Class,
  import: CompletionItemKind.Module,
};


export function declToCompletionItem(decl: Declaration, priority: number, table?: SymbolTable): CompletionItem {
  const isFunction = decl.kind === "function" || decl.kind === "method";
  const item: CompletionItem = {
    label: decl.name,
    kind: DECL_KIND_TO_COMPLETION_KIND[decl.kind] ?? CompletionItemKind.Text,
    sortText: padSortKey(priority) + decl.name,
    // filterText ensures the client matches against the plain identifier,
    // even if the label were to change (e.g., adding signature suffix).
    filterText: decl.name,
    // Add detail for function/method/variable declarations when available.
    // Type information helps the user pick the right completion without
    // needing to resolve or hover.
    detail: decl.declaredType ?? undefined,
  };

  // For functions/methods, add snippet support with parameter placeholders.
  // The snippet looks like: functionName(${1:param1}, ${2:param2})
  if (isFunction && decl.declaredType) {
    const params = extractParamsFromType(decl.declaredType);
    if (params !== null) {
      item.insertTextFormat = InsertTextFormat.Snippet;
      item.insertText = decl.name + "(" + params + ")";
    }
  }

  // For classes, generate a constructor snippet from the create() method's
  // parameters. This gives the user tab-to-fill when constructing: ClassName(${1:arg1}).
  if (decl.kind === "class" && table) {
    const createParams = extractConstructorParams(decl, table);
    if (createParams !== null) {
      item.insertTextFormat = InsertTextFormat.Snippet;
      item.insertText = decl.name + "(" + createParams + ")";
    }
  }

  // Commit characters: typing these after selecting a completion item
  // commits the item and inserts the character, triggering the next
  // action (dot-access completion or function-call parens).
  const commitChars = computeCommitCharacters(decl, isFunction);
  if (commitChars.length > 0) {
    item.commitCharacters = commitChars;
  }

  return item;
}

/**
 * Determine commit characters for a completion item.
 *
 * - Functions/methods: no commit characters — the snippet already includes
 *   the opening paren, so adding '(' as a commit char would double it.
 * - Classes: "." triggers dot completion. "(" is NOT included because
 *   constructor snippets already include it.
 * - Variables/parameters/inherit with a non-primitive type: "." triggers
 *   dot completion on the instance.
 */
function computeCommitCharacters(decl: Declaration, isFunction: boolean): string[] {
  if (isFunction) {
    // The snippet insertText already includes '(' — adding it as a commit
    // character causes double parens: name(${1:arg})( instead of name(arg).
    return [];
  }

  if (decl.kind === "class") {
    // Classes can be dot-accessed for static members.
    // '(' omitted for the same reason as functions (constructor snippet).
    return ["."];
  }

  // Variables, parameters, and inherit aliases with a known class type
  // get dot-commit so the user can chain into member access.
  const hasClassType = decl.kind === "variable"
    || decl.kind === "parameter"
    || decl.kind === "inherit";

  if (hasClassType && hasNonPrimitiveType(decl)) {
    return ["."];
  }

  return [];
}

/**
 * Check if a declaration has a declared or assigned type that is a class
 * (non-primitive) type. Primitive types like "string", "int", "mixed" etc.
 * never have members, so dot-access would not be useful.
 */
function hasNonPrimitiveType(decl: Declaration): boolean {
  const typeStr = decl.declaredType ?? decl.assignedType;
  if (!typeStr) return false;
  // The type string may contain qualifiers or whitespace — trim before
  // checking against the primitive set.
  return !PRIMITIVE_TYPES.has(typeStr.trim());
}

export function padSortKey(n: number): string {
  return String(n).padStart(4, "0");
}

// ---------------------------------------------------------------------------
// Declaration lookup
// ---------------------------------------------------------------------------

/**
 * Find the declaration for a name at a given position.
 * Walks scope chain to find the innermost declaration matching the name.
 */
export function findDeclarationForName(
  table: SymbolTable,
  name: string,
  line: number,
  character: number,
): Declaration | null {
  // Look for a reference at this position matching the name
  for (const ref of table.references) {
    if (ref.name === name && ref.resolvesTo !== null) {
      const decl = table.declById.get(ref.resolvesTo);
      if (decl) return decl;
    }
  }

  // Look for a declaration with this name in scope
  const symbols = getSymbolsInScope(table, line, character);
  return symbols.find(d => d.name === name) ?? null;
}

// ---------------------------------------------------------------------------
// Type member resolution
// ---------------------------------------------------------------------------

/**
 * Try to resolve the members of a declared type.
 * For class types, find the class scope and enumerate its declarations.
 */
export async function resolveTypeMembers(
  decl: Declaration,
  table: SymbolTable,
  ctx: CompletionContext,
): Promise<CompletionItem[]> {
  const items: CompletionItem[] = [];

  // If the declaration is a class, collect its members
  if (decl.kind === "class") {
    const memberDecls = collectClassMembers(table, decl);
    for (const cd of memberDecls) {
      items.push(declToCompletionItem(cd, 5, table));
    }
  }

  // If the declaration is a variable/parameter/function, resolve its type
  // Functions have declaredType set to their return type
  // Variables with assignedType use that when declaredType is absent/mixed
  if (decl.kind === "variable" || decl.kind === "parameter" || decl.kind === "function") {
    // Use assignedType when declaredType is absent or a primitive like 'mixed'
    let typeName = resolveTypeName(decl);

    // If static type resolution yields nothing, try runtime inference
    if (!typeName && decl.name && ctx.typeInferrer) {
      if (decl.kind === 'variable' || decl.kind === 'parameter') {
        try {
          typeName = await ctx.typeInferrer(decl.name);
        } catch {
          // Worker unavailable — proceed without inferred type
        }
      }
    }

    if (typeName) {
      const typeCtx = {
        table,
        uri: ctx.uri,
        index: ctx.index,
        stdlibIndex: ctx.stdlibIndex,
        typeInferrer: ctx.typeInferrer,
      };
      const result = await resolveType(typeName, typeCtx);
      if (result?.decl.kind === "class") {
        const ownerTable = result.table;
        const memberDecls = collectClassMembers(ownerTable, result.decl);
        for (const cd of memberDecls) {
          items.push(declToCompletionItem(cd, 5, ownerTable));
        }
      }
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Identifier prefix range detection for textEdit
// ---------------------------------------------------------------------------

/**
 * Find the range of the identifier prefix the user has typed.
 * Used to generate textEdit ranges for completion items.
 *
 * Walks the tree-sitter node at the cursor position. If the cursor is
 * inside an identifier node, returns the range from the identifier start
 * to the cursor. For dot/arrow/scope access, returns only the trailing
 * identifier part (after the dot/arrow/scope).
 *
 * Returns null if no identifier prefix is found (e.g., completion
 * triggered right after a dot with nothing typed yet).
 */
export function findIdentifierPrefixRange(
  tree: Tree,
  line: number,
  character: number,
): { start: { line: number; character: number }; end: { line: number; character: number } } | null {
  const root = tree.rootNode;
  if (!root) return null;
  const pos = { row: line, column: character };
  const lines = root.text.split('\n');

  // Try to find a node at this position. Use namedDescendantForPosition
  // to skip anonymous nodes (punctuation, whitespace).
  let node = root.namedDescendantForPosition(pos);
  if (!node) return null;

  // If the cursor is at the end of an identifier, use its range.
  // If the cursor is inside an identifier, use from start to cursor.
  if (node.type === "identifier") {
    return {
      start: {
        line: node.startPosition.row,
        character: utf8ToUtf16(lines[node.startPosition.row] ?? '', node.startPosition.column),
      },
      end: { line, character },
    };
  }

  // For error nodes (common during typing), look for an identifier child.
  if (node.type === "ERROR") {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child && child.type === "identifier") {
        // Only use if the cursor is inside or at the end of this identifier
        if (child.endPosition.row >= line && child.startPosition.column <= character) {
          return {
            start: {
              line: child.startPosition.row,
              character: utf8ToUtf16(lines[child.startPosition.row] ?? '', child.startPosition.column),
            },
            end: { line, character },
          };
        }
      }
    }
  }

  // No identifier prefix found — completion was triggered at a structural
  // boundary (e.g., right after a dot with nothing typed yet).
  return null;
}
