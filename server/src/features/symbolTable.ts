import { Tree } from 'web-tree-sitter';

// ---------------------------------------------------------------------------
// Types — mirrors decision 0009
// ---------------------------------------------------------------------------

export interface Location {
  line: number;
  character: number;
}

export interface Range {
  start: Location;
  end: Location;
}

export interface Declaration {
  id: number;
  name: string;
  kind: DeclKind;
  nameRange: Range;
  range: Range;
  scopeId: number;
  /** For inherit declarations: local alias (e.g. 'creature' in 'inherit Animal : creature'). */
  alias?: string;
  /**
   * Where the alias itself is written.
   *
   * `nameRange` covers the inherited path, which for `inherit "engine.pike" :
   * motor;` is a string literal — not a name any position query should match.
   * The alias is the name this file actually introduces, so it needs its own
   * range for highlight, references and rename to land on it.
   */
  aliasRange?: Range;
  /** For variables and parameters: the declared type annotation text, if present. */
  declaredType?: string;
  /** For variables: type inferred from assignment initializer (e.g., Dog d = makeDog()). */
  assignedType?: string;
  /** For synthetic declarations from cross-file inheritance/includes: URI of the origin file. */
  sourceUri?: string;
  /** For macro declarations: true when defined function-like, i.e. `NAME(args)`. */
  functionLike?: boolean;
  /** Visibility/storage modifiers on the declaration, e.g. ['private'], ['protected','variant']. */
  modifiers?: string[];
}

export type DeclKind =
  | 'function'
  | 'method'
  | 'class'
  | 'variable'
  | 'constant'
  | 'enum'
  | 'enum_member'
  | 'typedef'
  | 'parameter'
  // A parameter of a function-like `#define`. Kept apart from 'parameter'
  // because it has no type and no value — it is a substitution placeholder —
  // so the tiers that would otherwise answer it from Pike's predefs must not.
  // A macro parameter named `write` is not `predef::write`.
  | 'macro_parameter'
  | 'inherit'
  | 'import'
  // Preprocessor `#include "file.h"` / `#include <file.h>` directive. `name`
  // holds the raw path text (with quotes/brackets); resolved by wireIncludes.
  | 'include'
  // Preprocessor `#define NAME ...` macro. `functionLike` set for `NAME(args)`.
  | 'macro';

export interface Reference {
  name: string;
  loc: Location;
  kind: RefKind;
  resolvesTo: number | null; // Declaration.id, null if unresolved
  confidence: 'high' | 'medium' | 'low';
  /** For arrow/dot access: the LHS identifier name (e.g., 'd' in d->bark). */
  lhsName?: string;
  /**
   * For scope access: the text before the `::`.
   *
   * An inherit name or alias (`A` in `A::value()`), one of Pike's scope
   * keywords (`predef`, `global`, `this`, `this_program`, `local`), or the
   * empty string for a bare `::`. The qualifier is binding — Pike rejects
   * `A::only_b` outright when `only_b` belongs to a different inherit — so any
   * fallback that searches for the name must honour it rather than accept a
   * match from whichever inherit happens to come first.
   */
  scopeQualifier?: string;
}

export type RefKind =
  | 'identifier'
  | 'call'
  | 'arrow_access'
  | 'dot_access'
  | 'scope_access'
  | 'type_ref'
  | 'this_ref'
  | 'label'
  | 'inherit_ref';

export interface Scope {
  id: number;
  kind: ScopeKind;
  range: Range;
  parentId: number | null;
  declarations: number[]; // Declaration IDs
  inheritedScopes: number[]; // Scope IDs (class inheritance)
}

export type ScopeKind =
  | 'file'
  | 'class'
  | 'function'
  | 'lambda'
  | 'block'
  | 'for'
  | 'foreach'
  | 'if_cond'
  | 'while'
  | 'do_while'
  | 'switch'
  | 'catch'
  // The body of a function-like `#define`. Its only declarations are the
  // macro's parameters, and it exists so they shadow the file scope the way
  // Pike's preprocessor does: with `int X = 100;` and
  // `#define F(X) (X + X)`, `F(1)` is 2, not 200.
  | 'macro';
export interface SymbolTable {
  uri: string;
  version: number;
  declarations: Declaration[];
  references: Reference[];
  scopes: Scope[];
  /** O(1) lookup: declaration ID → Declaration. Populated at build time. */
  declById: Map<number, Declaration>;
  /** O(1) lookup: scope ID → Scope. Populated at build time. */
  scopeById: Map<number, Scope>;
}

// ---------------------------------------------------------------------------
// Builder state
// ---------------------------------------------------------------------------

export interface BuildState {
  nextId: number;
  declarations: Declaration[];
  references: Reference[];
  scopes: Scope[];
  scopeMap: Map<number, Scope>; // ID → Scope for O(1) lookup
  declMap: Map<number, Declaration>; // ID → Declaration for O(1) lookup
  scopeStack: number[]; // stack of scope IDs (innermost last)
  /** Scopes sorted by (startLine, startChar) after declaration pass, for binary search. */
  sortedScopes: Scope[];
}

// ---------------------------------------------------------------------------
// Re-exports from extracted modules
// ---------------------------------------------------------------------------

export {
  getSymbolsInScope,
  getDeclarationsInScope,
  findClassScopeAt,
  findProgramScopeAt,
} from './completion-scope';
export {
  PRIMITIVE_TYPES,
  resolveTypeName,
} from './scope-helpers';
export { wireInheritance } from './scopeBuilder';
export { wireIncludes } from './includeWiring';

// ---------------------------------------------------------------------------
// Internal imports (not re-exported)
// ---------------------------------------------------------------------------

import { toRange, resolveTypeName } from './scope-helpers';
import { pushScope, popScope } from './scope-helpers-state';
import { wireInheritance } from './scopeBuilder';
import { wireIncludes } from './includeWiring';
import { collectDeclarations } from './declarationCollector';
import { collectReferences } from './referenceCollector';
import { startSpan, stopSpan, bump, measureSync } from './profiler';

// ---------------------------------------------------------------------------
// Build orchestrator
// ---------------------------------------------------------------------------

/**
 * Cross-file resolution surface used during symbol-table build. Shared by
 * BuildOptions, wireInheritance, and wireIncludes so all three stay in sync.
 */
export interface BuildIndex {
  getSymbolTable(uri: string): SymbolTable | null;
  resolveImport(mod: string, from: string): string | null;
  resolveInherit(path: string, isString: boolean, from: string): string | null;
  resolveInclude(path: string, isSystem: boolean, from: string): string | null;
}

export interface BuildOptions {
  /** WorkspaceIndex for cross-file inheritance/include resolution. */
  index?: BuildIndex;
}

/**
 * Build a symbol table from a tree-sitter parse tree.
 *
 * Two passes:
 * 1. Collect declarations and build scope tree
 * 2. Collect references and resolve them
 *
 * @param options Optional WorkspaceIndex for cross-file inheritance wiring;
 *   pass `undefined` when no index is available.
 * @param sourceText Full source the tree was parsed from. REQUIRED and
 *   enforced by assertSourceCoversTree below — see that function's docstring
 *   for what the check protects against today (it is a caller-contract
 *   check, not the position-correctness guard it used to be: sourceText is
 *   not read anywhere else in this build pipeline).
 */
export function buildSymbolTable(tree: Tree, uri: string, version: number, options: BuildOptions | undefined, sourceText: string): SymbolTable {
  return measureSync("buildSymbolTable", () => {
    const root = tree.rootNode;
    if (!root) return emptySymbolTable(uri, version);

    bump("symbolTablesBuilt");
    assertSourceCoversTree(sourceText, root, uri);
    const state = initBuildState();

    startSpan("declarationPass");
    runDeclarationPass(root, state);
    stopSpan("declarationPass");

    startSpan("buildTable");
    const table = buildTable(state, uri, version);
    stopSpan("buildTable");

    // Propagate assignedType through variable aliases.
    // After extraction, variables initialized from other variables (e.g.,
    // `Dog d2 = d1;`) have assignedType set to the variable name ("d1"),
    // not the actual type ("Dog"). This pass looks up the initializer's
    // assignedType from the symbol table and propagates it.
    startSpan("propagateAssignedTypes");
    propagateAssignedTypes(table);
    stopSpan("propagateAssignedTypes");

    startSpan("wireInheritance");
    wireInheritance(table, options?.index, uri);
    bump("inheritanceWiringOps");
    stopSpan("wireInheritance");

    // Merge `#include`d files' top-level symbols (declarations + macros) into
    // this file's scope, so references below can resolve to them.
    startSpan("wireIncludes");
    wireIncludes(table, options?.index, uri);
    stopSpan("wireIncludes");

    startSpan("referencePass");
    runReferencePass(tree.rootNode, state, table);
    stopSpan("referencePass");

    return table;
  });
}

/**
 * Fail fast when a caller passes an empty/undefined sourceText for a tree
 * that actually has content.
 *
 * Historically (pre-PR #148, when BuildState still had a `lines` field and
 * scope ranges were derived from it) an omitted sourceText silently
 * collapsed the file scope to a zero-width range, so getSymbolsInScope and
 * completion returned nothing at end-of-line positions — a real bug (PR
 * #145: a test called buildSymbolTable without the arg and flaked on
 * suite order). That specific failure mode is gone now that BuildState.lines
 * and offsetMap have been removed: positions come straight from tree-sitter
 * Points, and sourceText is not read anywhere else in this file or its
 * helpers — grep confirms the only remaining use is this assertion.
 *
 * So this guard no longer prevents position corruption. What it still does:
 * fail loudly, at the API boundary, the moment a caller passes the wrong
 * variable or an empty string for a document that actually has content —
 * which is still a real caller bug worth surfacing immediately rather than
 * letting it manifest as a confusing downstream symptom later. The type
 * makes sourceText required, but bun runs tests without type-checking, so
 * this runtime guard protects the untyped test call sites too. endIndex is
 * an O(1) getter.
 */
function assertSourceCoversTree(sourceText: string, root: { endIndex: number }, uri: string): void {
  if ((sourceText === undefined || sourceText.length === 0) && root.endIndex > 0) {
    throw new Error(
      `buildSymbolTable(${uri}): sourceText is required for a non-empty tree ` +
        `(endIndex=${root.endIndex}); an empty/undefined value here means the ` +
        `caller passed the wrong variable or a stale/empty buffer for a real document.`,
    );
  }
}

/** Create an empty symbol table for failed parses. */
function emptySymbolTable(uri: string, version: number): SymbolTable {
  return {
    uri, version,
    declarations: [], references: [], scopes: [],
    declById: new Map(), scopeById: new Map(),
  };
}

/** Initialize fresh builder state. */
function initBuildState(): BuildState {
  return {
    nextId: 0,
    declarations: [],
    references: [],
    scopes: [],
    scopeMap: new Map(),
    declMap: new Map(),
    scopeStack: [],
    sortedScopes: [],
  };
}

/** Pass 1: collect declarations and build scope tree. */
function runDeclarationPass(root: any, state: BuildState): void {
  pushScope(state, 'file', toRange(root));
  collectDeclarations(root, state);
  popScope(state);

  // Sort scopes by start position for binary search in findScopeForNode.
  // Done here because all scopes are known after the declaration pass.
  state.sortedScopes = sortScopesByStart(state.scopes);
}

/** Build intermediate SymbolTable from state (before reference pass). */
function buildTable(state: BuildState, uri: string, version: number): SymbolTable {
  return {
    uri, version,
    declarations: state.declarations,
    references: [],
    scopes: state.scopes,
    declById: state.declMap,
    scopeById: state.scopeMap,
  };
}

/** Pass 2.5: propagate assignedType through variable aliases. */
function propagateAssignedTypes(table: SymbolTable): void {
  // Bounded by function scope (evict-eligible after propagation passes complete).
  const varTypes = new Map<string, string>();
  for (const decl of table.declarations) {
    if (decl.kind !== "variable") continue;
    const type = resolveTypeName(decl);
    if (type) {
      varTypes.set(decl.name, type);
    }
  }

  // For each declaration with an assignedType that matches a variable name
  // in scope, replace it with that variable's resolved type.
  // Limit propagation depth to prevent cycles (e.g., `mixed x = x;`).
  const MAX_PASSES = 5;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let changed = false;
    for (const decl of table.declarations) {
      if (decl.kind !== "variable") continue;
      if (!decl.assignedType) continue;

      // If assignedType is a known variable name, propagate its type.
      const sourceType = varTypes.get(decl.assignedType);
      if (sourceType && sourceType !== decl.assignedType) {
        decl.assignedType = sourceType;
        varTypes.set(decl.name, sourceType);
        changed = true;
      }
    }
    if (!changed) break;
  }
}

/** Pass 4: collect and resolve references. */
function runReferencePass(rootNode: any, state: BuildState, table: SymbolTable): void {
  state.references = table.references;
  collectReferences(rootNode, state);
  table.references = state.references;
}

// ---------------------------------------------------------------------------
// Public query API (delegated)
// ---------------------------------------------------------------------------

export { getDefinitionAt, getLocalDeclarationAt, declOccurrenceRangeAt, getReferencesTo, isWrittenInFile } from './query';

/**
 * Sort scopes by (startLine, startChar) for binary search in findScopeForNode.
 * Stable sort preserves ID order for scopes starting at the same position,
 * which matters for preferring higher IDs (deeper nesting) when ranges overlap.
 */
function sortScopesByStart(scopes: Scope[]): Scope[] {
  return [...scopes].sort((a, b) => {
    const lineDiff = a.range.start.line - b.range.start.line;
    if (lineDiff !== 0) return lineDiff;
    return a.range.start.character - b.range.start.character;
  });
}
