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
import { type SymbolTable, type Declaration, getSymbolsInScope, getDeclarationsInScope, findClassScopeAt } from "./symbolTable";
import { resolveMemberAccess } from "./typeResolver";
import {
  type CompletionContext,
  type TriggerContext,
  detectTriggerContext,
  getStdlibChildrenMap,
  getStdlibTopLevel,
  isCompletableIdentifier,
  getAllAutoImportEntries,
  declToCompletionItem,
  padSortKey,
  findDeclarationForName,
  resolveTypeMembers,
  cleanPredefSignature,
  resetCompletionCache,
  extractParamsFromPredefType,
  extractParamsFromStdlibSignature,
  extractConstructorParams,
  extractParamsFromType,
} from "./completionTrigger";

// Re-export for backward compatibility
export { type CompletionContext, resetCompletionCache } from "./completionTrigger";

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Get completions at a given position.
 */
export async function getCompletions(
  table: SymbolTable,
  tree: Tree,
  line: number,
  character: number,
  ctx: CompletionContext,
): Promise<CompletionList> {
  const root = tree.rootNode;
  // Position in tree-sitter is 0-indexed
  const pos = { row: line, column: character };

  // Get the node at or immediately before the cursor position
  let node = root.descendantForPosition(pos);
  if (!node) {
    return { isIncomplete: false, items: [] };
  }

  // Determine completion context
  const triggerContext = detectTriggerContext(node, line, character, tree, ctx.source.split("\n")[line] ?? "");

  let items: CompletionItem[];

  switch (triggerContext.type) {
    case "dot":
      items = await completeDotAccess(table, tree, line, character, triggerContext.lhsNode, ctx);
      break;
    case "arrow":
      items = await completeArrowAccess(table, tree, line, character, triggerContext.lhsNode, ctx);
      break;
    case "scope":
      items = await completeScopeAccess(table, tree, line, character, triggerContext.scopeNode, ctx);
      break;
    case "call_args":
      items = await completeCallArgs(table, tree, line, character, triggerContext.calleeName, ctx);
      break;
    case "unqualified":
    default:
      items = await completeUnqualified(table, tree, line, character, ctx, node);
      break;
  }

  return { isIncomplete: items.length > 50, items };
}

// ---------------------------------------------------------------------------
// Unqualified completion
// ---------------------------------------------------------------------------

/**
 * Find the line number where a new `inherit` statement should be inserted.
 *
 * Strategy: insert after the last existing inherit/import declaration.
 * If no inherits exist, insert at line 0 (before any code).
 *
 * Pike wraps inherit/import in `declaration` nodes containing `inherit_decl`
 * or `import_decl` children.
 */
function findInheritInsertLine(tree: Tree): number {
  const root = tree.rootNode;
  let lastInheritLine = -1;

  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i);
    if (!child) continue;
    // Pike wraps inherit/import in `declaration` nodes.
    if (child.type === "declaration") {
      const inner = child.child(0);
      if (inner && (inner.type === "inherit_decl" || inner.type === "import_decl")) {
        const endLine = child.endPosition.row;
        if (endLine > lastInheritLine) {
          lastInheritLine = endLine;
        }
      }
    }
  }

  // Insert after the last inherit, or at line 0 if none found.
  return lastInheritLine >= 0 ? lastInheritLine + 1 : 0;
}

async function completeUnqualified(
  table: SymbolTable,
  tree: Tree,
  line: number,
  character: number,
  ctx: CompletionContext,
  node: Node,
): Promise<CompletionItem[]> {
  const items: CompletionItem[] = [];
  const seenNames = new Set<string>();

  // 1. Local scope symbols
  const localSymbols = getSymbolsInScope(table, line, character);
  for (const decl of localSymbols) {
    if (seenNames.has(decl.name)) continue;
    seenNames.add(decl.name);
    items.push(declToCompletionItem(decl, 0, table));
  }

  // 2. Imported symbols (cross-file)
  const importDecls = table.declarations.filter(d => d.kind === "inherit" || d.kind === "import");
  for (const importDecl of importDecls) {
    const targetUri = await ctx.index.resolveInherit(importDecl.name, false, ctx.uri);
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
      items.push(declToCompletionItem(decl, 20, targetTable));
    }
  }

  // 2b. Implicit directory module.pmod — files inside Foo.pmod/ see symbols
  // from Foo.pmod/module.pmod without explicit inherit/import.
  const directoryModule = await ctx.index.resolver.findDirectoryModulePmod(ctx.uri);
  if (directoryModule) {
    const moduleTable = ctx.index.getSymbolTable(directoryModule);
    if (moduleTable) {
      const fileScope = moduleTable.scopes.find(s => s.kind === "file");
      if (fileScope) {
        const moduleDecls = getDeclarationsInScope(moduleTable, fileScope.id);
        for (const decl of moduleDecls) {
          if (seenNames.has(decl.name)) continue;
          seenNames.add(decl.name);
          items.push(declToCompletionItem(decl, 15, moduleTable));
        }
      }
    }
  }

  // 3. Predef builtins (skip operator-like backtick identifiers)
  for (const name of Object.keys(ctx.predefBuiltins)) {
    if (seenNames.has(name)) continue;
    // Skip Pike operator identifiers (backtick-prefixed, operators, brackets)
    if (!isCompletableIdentifier(name)) continue;
    seenNames.add(name);
    const builtinItem: CompletionItem = {
      label: name,
      kind: CompletionItemKind.Function,
      detail: cleanPredefSignature(ctx.predefBuiltins[name]),
      sortText: padSortKey(30) + name,
      // filterText: plain identifier so VSCode fuzzy-matches correctly
      // even though detail contains a full signature.
      filterText: name,
    };
    // Add argument snippet for predef builtins
    const predefParams = extractParamsFromPredefType(ctx.predefBuiltins[name]);
    if (predefParams !== null) {
      builtinItem.insertTextFormat = InsertTextFormat.Snippet;
      builtinItem.insertText = name + "(" + predefParams + ")";
    }
    items.push(builtinItem);
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
      filterText: name,
    });
  }

  // 5. Auto-import suggestions (F5)
  // When the user types an identifier that exists in a stdlib module but is
  // not yet imported, offer it with an additionalTextEdits that inserts
  // `inherit Module;` at the top of the file.
  const existingInherits = new Set(
    table.declarations
      .filter(d => d.kind === "inherit")
      .map(d => d.name),
  );

  // The node at cursor is the partial identifier being typed.
  const typedPrefix = node.type === "identifier" ? node.text : "";
  const prefixLower = typedPrefix.toLowerCase();

  if (prefixLower.length >= 2) {
    const allEntries = getAllAutoImportEntries(ctx.stdlibIndex);
    // Cap auto-import results to avoid flooding the completion list.
    let autoImportCount = 0;
    const AUTO_IMPORT_CAP = 10;

    for (const [symbolName, candidates] of allEntries) {
      if (autoImportCount >= AUTO_IMPORT_CAP) break;
      // Prefix filter — case-insensitive to match VSCode behavior
      if (!symbolName.toLowerCase().startsWith(prefixLower)) continue;
      // Skip symbols already available in the completion list
      if (seenNames.has(symbolName)) continue;

      for (const candidate of candidates) {
        if (autoImportCount >= AUTO_IMPORT_CAP) break;
        // Skip if module is already inherited
        if (existingInherits.has(candidate.module)) continue;

        const insertLine = findInheritInsertLine(tree);

        items.push({
          label: candidate.name,
          kind: candidate.kind,
          detail: `Auto-import from ${candidate.module}`,
          sortText: padSortKey(50) + candidate.name,
          filterText: candidate.name,
          additionalTextEdits: [
            {
              range: {
                start: { line: insertLine, character: 0 },
                end: { line: insertLine, character: 0 },
              },
              newText: `inherit ${candidate.module};\n`,
            },
          ],
        });
        autoImportCount++;
      }
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Dot / arrow access completion
// ---------------------------------------------------------------------------

async function completeDotAccess(
  table: SymbolTable,
  tree: Tree,
  line: number,
  character: number,
  lhsNode: Node,
  ctx: CompletionContext,
): Promise<CompletionItem[]> {
  return completeMemberAccess(table, tree, line, character, lhsNode, ctx, "dot");
}

async function completeArrowAccess(
  table: SymbolTable,
  tree: Tree,
  line: number,
  character: number,
  lhsNode: Node,
  ctx: CompletionContext,
): Promise<CompletionItem[]> {
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
async function completeMemberAccess(
  table: SymbolTable,
  tree: Tree,
  line: number,
  character: number,
  lhsNode: Node,
  ctx: CompletionContext,
  accessType: "dot" | "arrow",
): Promise<CompletionItem[]> {
  const items: CompletionItem[] = [];
  const seenNames = new Set<string>();
  const lhsText = lhsNode.text;

  // Strategy 1: lhs is a module/class name — check workspace index then stdlib
  const wsTarget = await ctx.index.resolveModule(lhsText, ctx.uri);
  if (wsTarget) {
    const targetTable = ctx.index.getSymbolTable(wsTarget);
    if (targetTable) {
      const fileScope = targetTable.scopes.find(s => s.kind === "file");
      if (fileScope) {
        const decls = getDeclarationsInScope(targetTable, fileScope.id);
        for (const decl of decls) {
          if (seenNames.has(decl.name)) continue;
          seenNames.add(decl.name);
          items.push(declToCompletionItem(decl, 0, targetTable));
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
      const memberItem: CompletionItem = {
        label: member.name,
        kind: member.kind,
        detail: member.signature || undefined,
        sortText: padSortKey(10) + member.name,
        filterText: member.name,
      };
      // Add argument snippet for stdlib methods/functions
      if (member.signature && (member.kind === CompletionItemKind.Method || member.kind === CompletionItemKind.Function)) {
        const stdlibParams = extractParamsFromStdlibSignature(member.signature);
        if (stdlibParams !== null) {
          memberItem.insertTextFormat = InsertTextFormat.Snippet;
          memberItem.insertText = member.name + "(" + stdlibParams + ")";
        }
      }
      items.push(memberItem);
    }
  }

  // Strategy 3: Resolve the type of the LHS expression.
  //
  // For simple identifiers (variable, parameter, function), look up the
  // declaration and resolve its declared/assigned type.
  // For chained calls (getContainer()->getItem()->), walk the postfix_expr
  // chain left-to-right, resolving the return type at each step.
  //
  // postfix_expr chain structure:
  //   postfix_expr
  //     postfix_expr
  //       postfix_expr
  //         primary_expr "getContainer"
  //       -> "getItem"
  //     ( argument_list )
  //
  // The rightmost call's return type is what we need.
  const resolvedDecl = await resolveChainedType(lhsNode, table, line, character, ctx);
  if (resolvedDecl && resolvedDecl.kind !== "inherit") {
    const typeMembers = await resolveTypeMembers(resolvedDecl, table, ctx);
    for (const item of typeMembers) {
      if (seenNames.has(item.label)) continue;
      seenNames.add(item.label);
      items.push(item);
    }
  }

  // Dot access hides private members (Pike convention: __ prefix).
  // Arrow access (->) shows all members, including private.
  if (accessType === "dot") {
    return items.filter(item => !item.label.startsWith("__"));
  }
  return items;
}

// ---------------------------------------------------------------------------
// Scope access completion (:: )
// ---------------------------------------------------------------------------

async function completeScopeAccess(
  table: SymbolTable,
  tree: Tree,
  line: number,
  character: number,
  scopeNode: Node,
  ctx: CompletionContext,
): Promise<CompletionItem[]> {
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
          items.push(declToCompletionItem(decl, 0, table));
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
            items.push(declToCompletionItem(decl, 0, table));
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
          const targetUri = await ctx.index.resolveInherit(decl.name, false, ctx.uri);
          if (targetUri) {
            const targetTable = ctx.index.getSymbolTable(targetUri);
            if (targetTable) {
              const fileScope = targetTable.scopes.find(s => s.kind === "file");
              if (fileScope) {
                const targetDecls = getDeclarationsInScope(targetTable, fileScope.id);
                for (const td of targetDecls) {
                  if (seenNames.has(td.name)) continue;
                  seenNames.add(td.name);
                  items.push(declToCompletionItem(td, 0, targetTable));
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
                      items.push(declToCompletionItem(td, 5, table));
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
// Chained call type resolution
// ---------------------------------------------------------------------------

/**
 * Maximum depth for chained call type resolution.
 * Prevents runaway resolution on deeply nested or recursive chains.
 */
const MAX_CHAIN_DEPTH = 5;

/**
 * Resolve the type of an LHS expression for member access completion.
 *
 * Handles three patterns:
 * 1. Simple identifier: `d->` — look up `d`'s declaration, resolve its type.
 * 2. Single function call: `makeDog()->` — look up `makeDog`, resolve return type.
 * 3. Chained calls: `getContainer()->getItem()->` — walk the chain step by step,
 *    resolving each method's return type.
 *
 * Returns the Declaration whose type should be enumerated for completion items.
 * For chained calls, returns the declaration of the rightmost call's return type.
 * Returns null if the chain cannot be resolved.
 */
async function resolveChainedType(
  lhsNode: Node,
  table: SymbolTable,
  line: number,
  character: number,
  ctx: CompletionContext,
): Promise<Declaration | null> {
  // Decompose the postfix_expr chain into steps.
  // Each step is either a base identifier or a ->memberName operation.
  const steps = decomposePostfixChain(lhsNode);
  if (steps.length === 0) {
    // Fallback: try simple name lookup on the raw node text.
    const name = lhsNode.text;
    return findDeclarationForName(table, name, line, character);
  }

  // Step 0: resolve the base identifier's declaration.
  const baseName = steps[0].baseName;
  let currentDecl = findDeclarationForName(table, baseName, line, character);
  if (!currentDecl) return null;

  // If there are no arrow steps, this is a simple case.
  // Return the base declaration so resolveTypeMembers can do its work.
  if (steps.length === 1 && !steps[0].memberName) {
    return currentDecl;
  }

  // Walk the chain: for each ->memberName step, resolve the member on
  // the current type, then set currentDecl to the member's declaration
  // (whose return type becomes the next step's type context).
  const typeCtx = {
    table,
    uri: ctx.uri,
    index: ctx.index,
    stdlibIndex: ctx.stdlibIndex,
    typeInferrer: ctx.typeInferrer,
  };

  for (let i = 0; i < steps.length && i < MAX_CHAIN_DEPTH; i++) {
    const step = steps[i];
    if (!step.memberName) continue;

    // Resolve the current type through the member access.
    // For each step, use that step's baseName (the identifier before the ->)
    // as the lookup name for the member access resolution.
    const member = await resolveMemberAccess(
      step.baseName,
      step.memberName,
      currentDecl,
      typeCtx,
    );
    if (!member) return null;

    // The member becomes the new "current declaration" for the next step.
    // If the member is a method/function, its declaredType is the return type.
    currentDecl = member;
  }

  return currentDecl;
}

/**
 * A single step in a postfix_expr chain.
 *
 * `baseName` is always set — it's the leftmost identifier.
 * `memberName` is set for arrow/dot access steps.
 */
interface ChainStep {
  baseName: string;
  memberName: string | null;
}

/**
 * Decompose a postfix_expr tree into a chain of steps.
 *
 * Given: `getContainer()->getItem()`
 * Tree: postfix_expr(postfix_expr(postfix_expr("getContainer") -> "getItem") (args))
 *
 * Returns:
 *   [{ baseName: "getContainer", memberName: null },
 *    { baseName: "getContainer", memberName: "getItem" }]
 *
 * Given: `d->bark()`
 * Tree: postfix_expr(postfix_expr("d") -> "bark") (args))
 *
 * Returns:
 *   [{ baseName: "d", memberName: null },
 *    { baseName: "d", memberName: "bark" }]
 *
 * Given: `makeDog()`
 * Tree: postfix_expr(postfix_expr("makeDog") (args))
 *
 * Returns:
 *   [{ baseName: "makeDog", memberName: null }]
 */
function decomposePostfixChain(node: Node): ChainStep[] {
  const steps: ChainStep[] = [];

  // Walk the postfix_expr chain from outside in, collecting ->member steps.
  let current: Node | null = node;
  const arrowSteps: string[] = [];

  while (current && current.type === "postfix_expr") {
    const children = current.children;
    // Look for arrow/dot operator followed by an identifier.
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if ((child.type === "->" || child.type === "->?" || child.type === "?->")
          && i + 1 < children.length) {
        const memberIdent = children[i + 1];
        if (memberIdent && memberIdent.type === "identifier") {
          arrowSteps.push(memberIdent.text);
        }
      }
    }

    // Move to the first child (the nested postfix_expr or primary_expr).
    const inner = current.child(0);
    if (inner && inner.type === "postfix_expr") {
      current = inner;
    } else {
      // Reached the base: extract the identifier.
      const baseName = extractIdentifier(inner);
      if (baseName) {
        steps.push({ baseName, memberName: null });
      }
      break;
    }
  }

  // Arrow steps were collected outside-in, so reverse them to get
  // the correct left-to-right order.
  arrowSteps.reverse();
  if (steps.length > 0) {
    for (const member of arrowSteps) {
      steps.push({ baseName: steps[0].baseName, memberName: member });
    }
  }

  return steps;
}

/**
 * Extract the identifier name from a node.
 * Handles identifier, identifier_expr, and primary_expr wrapping.
 */
function extractIdentifier(node: Node | null): string | null {
  if (!node) return null;
  if (node.type === "identifier") return node.text;
  if (node.type === "identifier_expr") {
    const nameNode = node.childForFieldName("name");
    return nameNode?.text ?? null;
  }
  if (node.type === "primary_expr") {
    return extractIdentifier(node.child(0));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Call-args completion (triggered by '(' after a function name)
// ---------------------------------------------------------------------------

/**
 * When the user types `funcName(`, offer a single completion item that
 * inserts argument placeholders with tab stops. This gives "type `(` and
 * get prompted with args" behavior.
 *
 * Resolution chain: local scope → imports → predef → stdlib → class constructors.
 */
async function completeCallArgs(
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
