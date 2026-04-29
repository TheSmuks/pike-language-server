/**
 * Completion provider for Pike LSP.
 *
 * Design: decision 0012.
 * Sources: symbol table (local scope), WorkspaceIndex (cross-file),
 * stdlib index (pre-built), predef builtins (pre-built).
 * No Pike worker dependency in the common case (~93% of completions).
 */

import { Tree, Node } from "web-tree-sitter";
import {
  CompletionItem,
  CompletionItemKind,
  CompletionList,
  InsertTextFormat,
} from "vscode-languageserver/node";
import {
  type SymbolTable,
  type Declaration,
  type DeclKind,
  type Range,
  getSymbolsInScope,
  getDeclarationsInScope,
  findClassScopeAt,
} from "./symbolTable";
import type { WorkspaceIndex } from "./workspaceIndex";
import { resolveType } from "./typeResolver";
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StdlibEntry {
  signature: string;
  markdown: string;
}

export interface CompletionContext {
  index: WorkspaceIndex;
  stdlibIndex: Record<string, StdlibEntry>;
  predefBuiltins: Record<string, string>;
  uri: string;
}

// ---------------------------------------------------------------------------
// Stdlib secondary index — prefix → direct children
// ---------------------------------------------------------------------------

interface StdlibMember {
  name: string;
  fqn: string;
  signature: string;
  kind: CompletionItemKind;
}

let stdlibChildrenMap: Map<string, StdlibMember[]> | null = null;
let stdlibTopLevelNames: { name: string; kind: CompletionItemKind }[] | null = null;

/**
 * Build the secondary stdlib index (lazy, once).
 * Maps FQN prefixes like "predef.Stdio.File" to their direct child members.
 */
function buildStdlibChildrenMap(
  stdlibIndex: Record<string, StdlibEntry>,
): Map<string, StdlibMember[]> {
  const map = new Map<string, StdlibMember[]>();

  for (const [fqn, entry] of Object.entries(stdlibIndex)) {
    const parts = fqn.split(".");
    if (parts.length < 2 || parts[0] !== "predef") continue;

    // The direct child name is the last segment
    const childName = parts[parts.length - 1];
    // The parent prefix is everything except the last segment
    const parentPrefix = parts.slice(0, -1).join(".");

    const member: StdlibMember = {
      name: childName,
      fqn,
      signature: entry.signature,
      kind: inferStdlibKind(entry.signature),
    };

    const existing = map.get(parentPrefix);
    if (existing) {
      existing.push(member);
    } else {
      map.set(parentPrefix, [member]);
    }
  }

  return map;
}

function getStdlibChildrenMap(
  stdlibIndex: Record<string, StdlibEntry>,
): Map<string, StdlibMember[]> {
  if (!stdlibChildrenMap) {
    stdlibChildrenMap = buildStdlibChildrenMap(stdlibIndex);
  }
  return stdlibChildrenMap;
}

/**
 * Get top-level stdlib module names (first segment after predef.).
 */
function getStdlibTopLevel(
  stdlibIndex: Record<string, StdlibEntry>,
): { name: string; kind: CompletionItemKind }[] {
  if (!stdlibTopLevelNames) {
    const names = new Map<string, CompletionItemKind>();
    for (const fqn of Object.keys(stdlibIndex)) {
      const parts = fqn.split(".");
      if (parts.length < 2 || parts[0] !== "predef") continue;
      const mod = parts[1];
      if (!names.has(mod)) {
        const entry = stdlibIndex[fqn];
        names.set(mod, inferStdlibKind(entry.signature));
      }
    }
    stdlibTopLevelNames = [...names.entries()].map(([name, kind]) => ({ name, kind }));
  }
  return stdlibTopLevelNames;
}

/**
 * Infer CompletionItemKind from a stdlib signature string.
 */
function inferStdlibKind(signature: string): CompletionItemKind {
  if (signature.startsWith("inherit ")) return CompletionItemKind.Class;
  if (signature.includes("(")) return CompletionItemKind.Method;
  if (/^(constant|final)\s/.test(signature)) return CompletionItemKind.Constant;
  return CompletionItemKind.Variable;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Get completions at a given position.
 */
export function getCompletions(
  table: SymbolTable,
  tree: Tree,
  line: number,
  character: number,
  ctx: CompletionContext,
): CompletionList {
  const root = tree.rootNode;
  // Position in tree-sitter is 0-indexed
  const pos = { row: line, column: character };

  // Get the node at or immediately before the cursor position
  let node = root.descendantForPosition(pos);
  if (!node) {
    return { isIncomplete: false, items: [] };
  }

  // Determine completion context
  const triggerContext = detectTriggerContext(node, line, character, tree);

  let items: CompletionItem[];

  switch (triggerContext.type) {
    case "dot":
      items = completeDotAccess(table, tree, line, character, triggerContext.lhsNode, ctx);
      break;
    case "arrow":
      items = completeArrowAccess(table, tree, line, character, triggerContext.lhsNode, ctx);
      break;
    case "scope":
      items = completeScopeAccess(table, tree, line, character, triggerContext.scopeNode, ctx);
      break;
    case "unqualified":
    default:
      items = completeUnqualified(table, line, character, ctx, node);
      break;
  }

  return { isIncomplete: items.length > 50, items };
}

// ---------------------------------------------------------------------------
// Trigger detection
// ---------------------------------------------------------------------------

type TriggerContext =
  | { type: "dot"; lhsNode: Node }
  | { type: "arrow"; lhsNode: Node }
  | { type: "scope"; scopeNode: Node }
  | { type: "unqualified" };

/**
 * Determine what kind of completion is requested based on the node at the cursor.
 */
function detectTriggerContext(
  node: Node,
  line: number,
  character: number,
  tree: Tree,
): TriggerContext {
  // Check if the cursor is right after a trigger character
  // The node at the cursor might be the trigger itself or an error node

  // Walk up from the node to find a postfix_expr or scope_expr
  let current: Node | null = node;

  // First check: is this a scope_expr? (Foo::member)
  if (current.type === "scope_expr") {
    const scopeNode = current.childForFieldName("scope");
    if (scopeNode) {
      return { type: "scope", scopeNode };
    }
  }

  // Check parent chain for scope_expr
  let parent: Node | null = current.parent;
  while (parent) {
    if (parent.type === "scope_expr") {
      const scopeNode = parent.childForFieldName("scope");
      if (scopeNode) {
        return { type: "scope", scopeNode };
      }
    }
    parent = parent.parent;
  }

  // Check for dot or arrow access in postfix_expr
  // Pattern: postfix_expr = expr '.' identifier | expr '->' identifier
  current = node;

  // If the node is an identifier inside a postfix_expr, look for the operator
  if (current.parent?.type === "postfix_expr") {
    const siblings = current.parent.children;
    for (let i = 0; i < siblings.length; i++) {
      const child = siblings[i];
      if (child.type === "." && i > 0) {
        return { type: "dot", lhsNode: siblings[i - 1] };
      }
      if ((child.type === "->" || child.type === "->?" || child.type === "?->") && i > 0) {
        return { type: "arrow", lhsNode: siblings[i - 1] };
      }
    }
  }

  // Check if the node itself is the operator or just after it
  // Case: cursor right after typing '.' or '->'
  // The tree might have the dot/arrow as a sibling of the current node
  if (current.type === "." && current.parent?.type === "postfix_expr") {
    const siblings = current.parent.children;
    const dotIdx = siblings.indexOf(current);
    if (dotIdx > 0) {
      return { type: "dot", lhsNode: siblings[dotIdx - 1] };
    }
  }

  if ((current.type === "->" || current.type === "->?" || current.type === "?->") && current.parent?.type === "postfix_expr") {
    const siblings = current.parent.children;
    const arrowIdx = siblings.indexOf(current);
    if (arrowIdx > 0) {
      return { type: "arrow", lhsNode: siblings[arrowIdx - 1] };
    }
  }

  // Check parent for the same pattern
  parent = current.parent;
  if (parent?.type === "postfix_expr") {
    const siblings = parent.children;
    for (let i = 0; i < siblings.length; i++) {
      const child = siblings[i];
      if (child.type === "." && i > 0) {
        return { type: "dot", lhsNode: siblings[i - 1] };
      }
      if ((child.type === "->" || child.type === "->?" || child.type === "?->") && i > 0) {
        return { type: "arrow", lhsNode: siblings[i - 1] };
      }
    }
  }

  // Check for ':' after ':' (:: trigger) — look for inherit_specifier
  if (current.type === "::" || current.type === "inherit_specifier") {
    // Cursor is right after ::
    let scopeNode: Node | null = current;
    if (current.type === "::") {
      scopeNode = current.parent; // inherit_specifier
    }
    if (scopeNode) {
      return { type: "scope", scopeNode };
    }
  }

  // Check if the text right before the cursor is "->" or "::"
  // This handles the case where the tree hasn't been updated yet
  // or where trailing expressions (e.g., 'Stdio.\n') produce ERROR nodes.
  const rootNode = tree.rootNode;
  const lineText = rootNode.text.split("\n")[line] ?? "";

  if (character >= 1) {
    const oneBefore = lineText[character - 1];

    // Dot access: 'Foo.' → find 'Foo' before the dot
    if (oneBefore === ".") {
      const lhs = findLhsBeforePosition(rootNode, line, character - 1);
      if (lhs) return { type: "dot", lhsNode: lhs };
    }

    // Arrow access: '->' — check if preceding char is '-'
    if (oneBefore === ">" && character >= 2 && lineText[character - 2] === "-") {
      const lhs = findLhsBeforePosition(rootNode, line, character - 2);
      if (lhs) return { type: "arrow", lhsNode: lhs };
    }
  }

  if (character >= 2) {
    const twoBefore = lineText.substring(character - 2, character);

    // Arrow access: 'obj->'
    if (twoBefore === "->") {
      const lhs = findLhsBeforePosition(rootNode, line, character - 2);
      if (lhs) return { type: "arrow", lhsNode: lhs };
    }

    // Scope access: 'Foo::'
    if (twoBefore === "::") {
      const lhs = findLhsBeforePosition(rootNode, line, character - 2);
      if (lhs) return { type: "scope", scopeNode: lhs };
    }
  }

  return { type: "unqualified" };
}

/**
 * Find the left-hand side identifier/expression before a trigger position.
 * Handles ERROR nodes by walking children to find the last valid identifier.
 */
function findLhsBeforePosition(rootNode: Node, line: number, column: number): Node | null {
  const pos = { row: line, column };
  let node = rootNode.descendantForPosition(pos);

  // If the node is an identifier, use it directly
  if (node && (node.type === "identifier" || node.type === "identifier_expr")) {
    return node;
  }

  // If the node is a postfix_expr, find the leftmost child that's an expression
  if (node && node.type === "postfix_expr") {
    return node.child(0);
  }
  // If the node is an anonymous operator token (e.g., '->', '.', '::'),
  // look at the parent for context.
  if (node && isOperatorToken(node.type)) {
    // If parent is ERROR, use the ERROR handling below
    if (node.parent?.type === "ERROR") {
      node = node.parent;
    } else if (node.parent?.type === "postfix_expr") {
      // Valid postfix_expr: the identifier before the operator is a sibling
      const siblings = node.parent.children;
      let opIdx = -1;
      for (let i = 0; i < siblings.length; i++) {
        if (siblings[i].equals(node)) { opIdx = i; break; }
      }
      if (opIdx > 0) {
        const prev = siblings[opIdx - 1];
        return findIdentifierInExpr(prev);
      }
    } else {
      // Operator token with unknown parent — try fallback
      if (column > 0) {
        const fallbackPos = { row: line, column: column - 1 };
        const fallback = rootNode.descendantForPosition(fallbackPos);
        if (fallback) return findIdentifierInExpr(fallback);
      }
      return null;
    }
  }


  // If the node is an ERROR, walk its children for the last valid identifier/expression
  if (node && node.type === "ERROR") {
    let best: Node | null = null;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child && (child.type === "identifier" || child.type === "identifier_expr" ||
          child.type === "postfix_expr")) {
        best = child;
      }
    }
    if (best) {
      if (best.type === "postfix_expr") return best.child(0);
      return best;
    }

    // ERROR might be just the operator (e.g., '->') with the expression
    // in a previous sibling. Check previous siblings.
    if (node.parent) {
      const siblings = node.parent.children;
      // Tree-sitter node wrappers are not reference-identical;
      // use equals() to find the ERROR's index among siblings.
      let errorIdx = -1;
      for (let i = 0; i < siblings.length; i++) {
        if (siblings[i].equals(node)) { errorIdx = i; break; }
      }
      for (let i = errorIdx - 1; i >= 0; i--) {
        const sib = siblings[i];
        if (sib.type === "comma_expr" || sib.type === "expression_statement") {
          // Drill into expression to find the identifier
          return findIdentifierInExpr(sib);
        }
      }
    }
  }

  // Fall back: try position one column before the trigger
  if (column > 0) {
    const fallbackPos = { row: line, column: column - 1 };
    const fallback = rootNode.descendantForPosition(fallbackPos);
    if (fallback && (fallback.type === "identifier" || fallback.type === "identifier_expr")) {
      return fallback;
    }
    // The fallback node might be deep inside expression nesting — walk up
    // to find an identifier
    if (fallback) {
      const ident = findIdentifierInExpr(fallback);
      if (ident) return ident;
    }
  }

  return null;
}

/**
 * Drill into an expression node tree to find the leaf identifier.
 * Pike expressions nest deeply (comma_expr → assign_expr → ... → postfix_expr → identifier).
 */
function findIdentifierInExpr(node: Node): Node | null {
  if (node.type === "identifier" || node.type === "identifier_expr") {
    return node;
  }
  // Check direct children first (deepest-nested is the leaf)
  const child = node.child(node.childCount - 1);
  if (child) {
    return findIdentifierInExpr(child);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unqualified completion
// ---------------------------------------------------------------------------

function completeUnqualified(
  table: SymbolTable,
  line: number,
  character: number,
  ctx: CompletionContext,
  node: Node,
): CompletionItem[] {
  const items: CompletionItem[] = [];
  const seenNames = new Set<string>();

  // 1. Local scope symbols
  const localSymbols = getSymbolsInScope(table, line, character);
  for (const decl of localSymbols) {
    if (seenNames.has(decl.name)) continue;
    seenNames.add(decl.name);
    items.push(declToCompletionItem(decl, 0));
  }

  // 2. Imported symbols (cross-file)
  const importDecls = table.declarations.filter(d => d.kind === "inherit" || d.kind === "import");
  for (const importDecl of importDecls) {
    const targetUri = ctx.index.resolveInherit(importDecl.name, false, ctx.uri);
    if (!targetUri) continue;
    const targetTable = ctx.index.getSymbolTable(targetUri);
    if (!targetTable) continue;
    // Get top-level declarations from the imported file
    const fileScope = targetTable.scopes.find(s => s.kind === "file");
    if (!fileScope) continue;
    const importedDecls = getDeclarationsInScope(targetTable, fileScope.id);
    for (const decl of importedDecls) {
      if (seenNames.has(decl.name)) continue;
      seenNames.add(decl.name);
      items.push(declToCompletionItem(decl, 20));
    }
  }

  // 3. Predef builtins (skip operator-like backtick identifiers)
  for (const name of Object.keys(ctx.predefBuiltins)) {
    if (seenNames.has(name)) continue;
    // Skip Pike operator identifiers (backtick-prefixed, operators, brackets)
    if (!isCompletableIdentifier(name)) continue;
    seenNames.add(name);
    items.push({
      label: name,
      kind: CompletionItemKind.Function,
      detail: cleanPredefSignature(ctx.predefBuiltins[name]),
      sortText: padSortKey(30) + name,
    });
  }

  // 4. Top-level stdlib modules/classes
  const stdlibTopLevel = getStdlibTopLevel(ctx.stdlibIndex);
  for (const { name, kind } of stdlibTopLevel) {
    if (seenNames.has(name)) continue;
    seenNames.add(name);
    items.push({
      label: name,
      kind,
      sortText: padSortKey(40) + name,
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// Dot / arrow access completion
// ---------------------------------------------------------------------------

function completeDotAccess(
  table: SymbolTable,
  tree: Tree,
  line: number,
  character: number,
  lhsNode: Node,
  ctx: CompletionContext,
): CompletionItem[] {
  return completeMemberAccess(table, tree, line, character, lhsNode, ctx, "dot");
}

function completeArrowAccess(
  table: SymbolTable,
  tree: Tree,
  line: number,
  character: number,
  lhsNode: Node,
  ctx: CompletionContext,
): CompletionItem[] {
  return completeMemberAccess(table, tree, line, character, lhsNode, ctx, "arrow");
}

/**
 * Complete member access after '.' or '->'.
 *
 * Strategies:
 * 1. If lhs is a known module path (e.g., Stdio.File) → resolve via WorkspaceIndex + stdlib
 * 2. If lhs is a declared variable with known type → resolve type to class scope
 * 3. If lhs is a class name → enumerate class members
 */
function completeMemberAccess(
  table: SymbolTable,
  tree: Tree,
  line: number,
  character: number,
  lhsNode: Node,
  ctx: CompletionContext,
  _accessType: "dot" | "arrow",
): CompletionItem[] {
  const items: CompletionItem[] = [];
  const seenNames = new Set<string>();
  const lhsText = lhsNode.text;

  // Strategy 1: lhs is a module/class name — check workspace index then stdlib
  const wsTarget = ctx.index.resolveModule(lhsText, ctx.uri);
  if (wsTarget) {
    const targetTable = ctx.index.getSymbolTable(wsTarget);
    if (targetTable) {
      const fileScope = targetTable.scopes.find(s => s.kind === "file");
      if (fileScope) {
        const decls = getDeclarationsInScope(targetTable, fileScope.id);
        for (const decl of decls) {
          if (seenNames.has(decl.name)) continue;
          seenNames.add(decl.name);
          items.push(declToCompletionItem(decl, 0));
        }
      }
    }
  }

  // Strategy 2: Check stdlib index for this prefix
  const stdlibPrefix = "predef." + lhsText;
  const childrenMap = getStdlibChildrenMap(ctx.stdlibIndex);
  const stdlibMembers = childrenMap.get(stdlibPrefix);
  if (stdlibMembers) {
    for (const member of stdlibMembers) {
      if (seenNames.has(member.name)) continue;
      seenNames.add(member.name);
      items.push({
        label: member.name,
        kind: member.kind,
        detail: member.signature || undefined,
        sortText: padSortKey(10) + member.name,
      });
    }
  }

  // Strategy 3: lhs is a declared variable — resolve its type
  // Find if lhsNode text matches a declaration with a known type
  const lhsDecl = findDeclarationForName(table, lhsText, line, character);
  if (lhsDecl && lhsDecl.kind !== "inherit") {
    // Try to resolve the declared type
    const typeMembers = resolveTypeMembers(lhsDecl, table, ctx);
    for (const item of typeMembers) {
      if (seenNames.has(item.label)) continue;
      seenNames.add(item.label);
      items.push(item);
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Scope access completion (:: )
// ---------------------------------------------------------------------------

function completeScopeAccess(
  table: SymbolTable,
  tree: Tree,
  line: number,
  character: number,
  scopeNode: Node,
  ctx: CompletionContext,
): CompletionItem[] {
  const items: CompletionItem[] = [];
  const seenNames = new Set<string>();
  const scopeText = scopeNode.text;

  // local:: — complete from enclosing class + inherited
  if (scopeText === "local") {
    const classScopeId = findClassScopeAt(table, line, character);
    if (classScopeId !== null) {
      const classScope = table.scopeById.get(classScopeId);
      if (classScope) {
        const decls = getDeclarationsInScope(table, classScopeId);
        for (const decl of decls) {
          if (seenNames.has(decl.name)) continue;
          seenNames.add(decl.name);
          items.push(declToCompletionItem(decl, 0));
        }
      }
    }
    return items;
  }

  // Bare :: — first inherited class
  if (scopeText === "::" || scopeNode.type === "inherit_specifier") {
    // Check if this is a bare :: (no identifier before it)
    const children = scopeNode.children;
    const hasIdentifier = children.some(c => c.type === "identifier");
    if (!hasIdentifier) {
      // Bare :: — members of first inherited class
      const classScopeId = findClassScopeAt(table, line, character);
      if (classScopeId !== null) {
        const classScope = table.scopeById.get(classScopeId);
        if (classScope && classScope.inheritedScopes.length > 0) {
          const firstInherited = classScope.inheritedScopes[0];
          const decls = getDeclarationsInScope(table, firstInherited);
          for (const decl of decls) {
            if (seenNames.has(decl.name)) continue;
            seenNames.add(decl.name);
            items.push(declToCompletionItem(decl, 0));
          }
        }
      }
      return items;
    }
  }

  // Identifier:: — resolve identifier to inherit declaration
  const inheritName = scopeText;
  // Find the inherit declaration with this name/alias in the enclosing class
  const classScopeId = findClassScopeAt(table, line, character);
  if (classScopeId !== null) {
    const classScope = table.scopeById.get(classScopeId);
    if (classScope) {
      // Find the inherit declaration
      for (const declId of classScope.declarations) {
        const decl = table.declById.get(declId);
        if (decl && (decl.kind === "inherit" || decl.kind === "import") && (decl.name === inheritName || decl.alias === inheritName)) {
          // Resolve to target
          const targetUri = ctx.index.resolveInherit(decl.name, false, ctx.uri);
          if (targetUri) {
            const targetTable = ctx.index.getSymbolTable(targetUri);
            if (targetTable) {
              const fileScope = targetTable.scopes.find(s => s.kind === "file");
              if (fileScope) {
                const targetDecls = getDeclarationsInScope(targetTable, fileScope.id);
                for (const td of targetDecls) {
                  if (seenNames.has(td.name)) continue;
                  seenNames.add(td.name);
                  items.push(declToCompletionItem(td, 0));
                }
              }
            }
          }
          // Also check same-file inheritance
          for (const inheritedId of classScope.inheritedScopes) {
            const inheritedScope = table.scopeById.get(inheritedId);
            if (inheritedScope) {
              const parentScope = inheritedScope.parentId !== null ? table.scopeById.get(inheritedScope.parentId) : undefined;
              if (parentScope) {
                for (const parentDeclId of parentScope.declarations) {
                  const parentDecl = table.declById.get(parentDeclId);
                  if (parentDecl && parentDecl.kind === "class" && parentDecl.name === decl.name) {
                    const targetDecls = getDeclarationsInScope(table, inheritedId);
                    for (const td of targetDecls) {
                      if (seenNames.has(td.name)) continue;
                      seenNames.add(td.name);
                      items.push(declToCompletionItem(td, 5));
                    }
                  }
                }
              }
            }
          }
          break;
        }
      }
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if a node type is an anonymous operator token that triggers completion. */
const OPERATOR_TOKENS = new Set(["->", "->?", "?->", ".", "::"]);
function isOperatorToken(type: string): boolean {
  return OPERATOR_TOKENS.has(type);
}

/**
 * Check if a name is a valid completable identifier (not an operator).
 * Filters out Pike backtick identifiers and operators like `>`, `==`, `->`, etc.
 */
function isCompletableIdentifier(name: string): boolean {
  // Skip backtick identifiers (operators like `->`, `+`, `[]`)
  if (name.startsWith("`")) return false;
  // Skip pure operator tokens
  if (/^[<>!=&|^~%/*+\-]+$/.test(name)) return false;
  // Skip bracket-like tokens
  if (/^[\[\](){}]+$/.test(name)) return false;
  // Must start with a letter or underscore
  if (!/^[a-zA-Z_]/.test(name)) return false;
  return true;
}


const DECL_KIND_TO_COMPLETION_KIND: Record<DeclKind, CompletionItemKind> = {
  function: CompletionItemKind.Function,
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

/** Primitive Pike types that can never resolve to a class with members. */
const PRIMITIVE_TYPES = new Set([
  "void", "mixed", "zero", "int", "float", "string",
  "array", "mapping", "multiset", "object", "function", "program",
  "bool", "auto", "any",
]);

function declToCompletionItem(decl: Declaration, priority: number): CompletionItem {
  return {
    label: decl.name,
    kind: DECL_KIND_TO_COMPLETION_KIND[decl.kind] ?? CompletionItemKind.Text,
    sortText: padSortKey(priority) + decl.name,
  };
}

function padSortKey(n: number): string {
  return String(n).padStart(4, "0");
}

/**
 * Find the declaration for a name at a given position.
 * Walks scope chain to find the innermost declaration matching the name.
 */
function findDeclarationForName(
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

/**
 * Try to resolve the members of a declared type.
 * For class types, find the class scope and enumerate its declarations.
 */
function resolveTypeMembers(
  decl: Declaration,
  table: SymbolTable,
  ctx: CompletionContext,
): CompletionItem[] {
  const items: CompletionItem[] = [];

  // If the declaration is a class, find its class scope
  if (decl.kind === "class") {
    const classScope = table.scopes.find(s =>
      s.kind === "class" &&
      s.parentId === decl.scopeId &&
      rangeContains(s.range, decl.nameRange.start),
    );
    if (classScope) {
      const classDecls = getDeclarationsInScope(table, classScope.id);
      for (const cd of classDecls) {
        items.push(declToCompletionItem(cd, 5));
      }
    }
  }

  // If the declaration is a variable/parameter, resolve its declared type
  if ((decl.kind === "variable" || decl.kind === "parameter") && decl.declaredType) {
    const typeName = decl.declaredType;
    // Skip primitive types that can never have members
    if (!PRIMITIVE_TYPES.has(typeName)) {
      // Use typeResolver for same-file, cross-file, and qualified type resolution
      const result = resolveType(typeName, {
        table,
        uri: ctx.uri,
        index: ctx.index,
        stdlibIndex: ctx.stdlibIndex,
      });
      if (result?.decl.kind === "class") {
        const ownerTable = result.table;
        // Find the class body scope — it's a child of the scope containing the class declaration
        const classScope = ownerTable.scopes.find(s =>
          s.kind === "class" && s.parentId === result.decl.scopeId &&
          rangeContains(s.range, result.decl.nameRange.start),
        );
        if (classScope) {
          const classDecls = getDeclarationsInScope(ownerTable, classScope.id);
          for (const cd of classDecls) {
            items.push(declToCompletionItem(cd, 5));
          }
          // Include inherited members
          for (const inheritedId of classScope.inheritedScopes) {
            const inheritedDecls = getDeclarationsInScope(ownerTable, inheritedId);
            for (const cd of inheritedDecls) {
              items.push(declToCompletionItem(cd, 5));
            }
          }
        }
      }
    }
  }

  return items;
}


/** Check if a position is within a range (inclusive start, exclusive end). */
function rangeContains(range: Range, pos: { line: number; character: number }): boolean {
  const { start, end } = range;
  if (pos.line < start.line || pos.line > end.line) return false;
  if (pos.line === start.line && pos.character < start.character) return false;
  if (pos.line === end.line && pos.character > end.character) return false;
  return true;
}

/**
 * Clean a predef builtin signature for display.
 * Removes scope wrappers and simplifies overloaded signatures.
 */
function cleanPredefSignature(raw: string): string {
  // Remove scope(0,...) wrapper
  let sig = raw;
  if (sig.startsWith("scope(")) {
    // Extract inner part
    const inner = sig.slice(6, -1);
    // Take the first overload if multiple
    const parts = inner.split(" | function");
    sig = parts[0].trim();
    // Remove leading "function" if present
    if (sig.startsWith("function")) {
      sig = sig.slice(8).trim();
    }
  }
  return sig || raw;
}

// ---------------------------------------------------------------------------
// Reset (for testing)
// ---------------------------------------------------------------------------

/**
 * Reset cached indices. Used in tests to avoid state leaking between runs.
 */
export function resetCompletionCache(): void {
  stdlibChildrenMap = null;
  stdlibTopLevelNames = null;
}
