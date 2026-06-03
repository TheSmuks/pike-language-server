import { Tree } from 'web-tree-sitter';
import type { OffsetMap } from '../util/offsetMap';

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
  /** For variables and parameters: the declared type annotation text, if present. */
  declaredType?: string;
  /** For variables: type inferred from assignment initializer (e.g., Dog d = makeDog()). */
  assignedType?: string;
  /** For synthetic declarations from cross-file inheritance: URI of the origin file. */
  sourceUri?: string;
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
  | 'inherit'
  | 'import';

export interface Reference {
  name: string;
  loc: Location;
  kind: RefKind;
  resolvesTo: number | null; // Declaration.id, null if unresolved
  confidence: 'high' | 'medium' | 'low';
  /** For arrow/dot access: the LHS identifier name (e.g., 'd' in d->bark). */
  lhsName?: string;
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
  | 'catch';
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
  lines: string[]; // pre-split source lines for UTF-16 position conversion
  /** Pre-computed byte→UTF-16 offset map per line. Built once at init, O(1) per lookup. */
  offsetMap: OffsetMap;
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
} from './completion-scope';
export {
  PRIMITIVE_TYPES,
  resolveTypeName,
} from './scope-helpers';
export { wireInheritance } from './scopeBuilder';

// ---------------------------------------------------------------------------
// Internal imports (not re-exported)
// ---------------------------------------------------------------------------

import { pushScope, popScope, toRangeUtf16, resolveTypeName } from './scope-helpers';
import { wireInheritance } from './scopeBuilder';
import { collectDeclarations } from './declarationCollector';
import { collectReferences } from './referenceCollector';
import { startSpan, stopSpan, bump, measureSync } from './profiler';
import { buildOffsetMap } from '../util/offsetMap';

// ---------------------------------------------------------------------------
// Build orchestrator
// ---------------------------------------------------------------------------

export interface BuildOptions {
  /** WorkspaceIndex for cross-file inheritance resolution. */
  index?: {
    getSymbolTable(uri: string): SymbolTable | null;
    resolveImport(mod: string, from: string): string | null;
    resolveInherit(path: string, isString: boolean, from: string): string | null;
  };
}

/**
 * Build a symbol table from a tree-sitter parse tree.
 *
 * Two passes:
 * 1. Collect declarations and build scope tree
 * 2. Collect references and resolve them
 *
 * @param index Optional WorkspaceIndex for cross-file inheritance wiring.
 * @param sourceText Pre-split source text.
 */
export function buildSymbolTable(tree: Tree, uri: string, version: number, options?: BuildOptions, sourceText?: string): SymbolTable {
  return measureSync("buildSymbolTable", () => {
    const root = tree.rootNode;
    if (!root) return emptySymbolTable(uri, version);

    bump("symbolTablesBuilt");
    const state = initBuildState(root, sourceText ?? '');

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

    startSpan("referencePass");
    runReferencePass(tree.rootNode, state, table);
    stopSpan("referencePass");

    return table;
  });
}

/** Create an empty symbol table for failed parses. */
function emptySymbolTable(uri: string, version: number): SymbolTable {
  return {
    uri, version,
    declarations: [], references: [], scopes: [],
    declById: new Map(), scopeById: new Map(),
  };
}

/** Initialize builder state from the root node. */
function initBuildState(root: { text: string }, sourceText: string): BuildState {
  const lines = sourceText.split('\n');
  return {
    nextId: 0,
    declarations: [],
    references: [],
    scopes: [],
    scopeMap: new Map(),
    declMap: new Map(),
    scopeStack: [],
    lines,
    offsetMap: buildOffsetMap(lines),
    sortedScopes: [],
  };
}

/** Pass 1: collect declarations and build scope tree. */
function runDeclarationPass(root: any, state: BuildState): void {
  pushScope(state, 'file', toRangeUtf16(root, state.lines, state.offsetMap));
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

export { getDefinitionAt, getReferencesTo } from './query';

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
