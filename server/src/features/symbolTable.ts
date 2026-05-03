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
  /** For variables and parameters: the declared type annotation text, if present. */
  declaredType?: string;
  /** For variables: type inferred from assignment initializer (e.g., Dog d = makeDog()). */
  assignedType?: string;
  /** For synthetic declarations from cross-file inheritance: URI of the origin file. */
  sourceUri?: string;
}

export type DeclKind =
  | 'function'
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
  | 'switch';
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

import { pushScope, popScope, toRange, resolveTypeName } from './scope-helpers';
import { wireInheritance } from './scopeBuilder';
import { collectDeclarations } from './declarationCollector';
import { collectReferences } from './referenceCollector';

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
 */
export function buildSymbolTable(tree: Tree, uri: string, version: number, options?: BuildOptions): SymbolTable {
  const root = tree.rootNode;
  if (!root) {
    // Parse produced no root node — return empty table
    return {
      uri,
      version,
      declarations: [],
      references: [],
      scopes: [],
      declById: new Map(),
      scopeById: new Map(),
    };
  }

  const state: BuildState = {
    nextId: 0,
    declarations: [],
    references: [],
    scopes: [],
    scopeMap: new Map(),
    declMap: new Map(),
    scopeStack: [],
  };

  // Pass 1: declarations + scope tree
  pushScope(state, 'file', toRange(root));
  collectDeclarations(root, state);
  popScope(state); // file scope

  // Pass 2: build the table so we can wire inheritance
  const table: SymbolTable = {
    uri,
    version,
    declarations: state.declarations,
    references: [], // filled in pass 4
    scopes: state.scopes,
    declById: state.declMap,
    scopeById: state.scopeMap,
  };

  // Pass 3: wire inheritance BEFORE reference resolution
  wireInheritance(table, options?.index, uri);

  // Pass 4: collect and resolve references (inheritance now wired)
  state.references = table.references;
  collectReferences(tree.rootNode, state);
  table.references = state.references;

  return table;
}

// ---------------------------------------------------------------------------
// Public query API
// ---------------------------------------------------------------------------

/**
 * Find the declaration at a given position (for go-to-definition).
 */
export function getDefinitionAt(
  table: SymbolTable,
  line: number,
  character: number,
): Declaration | null {
  // Find a reference at this position
  for (const ref of table.references) {
    if (ref.loc.line === line && ref.loc.character === character) {
      if (ref.resolvesTo !== null) {
        return table.declById.get(ref.resolvesTo) ?? null;
      }
    }
  }

  // Also check if the position is on a declaration name itself
  for (const decl of table.declarations) {
    const nr = decl.nameRange;
    if (nr.start.line === line && nr.end.line === line &&
        character >= nr.start.character && character <= nr.end.character) {
      // For inherit declarations, follow through to the target class
      if (decl.kind === 'inherit' || decl.kind === 'import') {
        const target = resolveInheritToClass(decl, table);
        if (target) return target;
      }
      return decl;
    }
    // For inherit declarations with alias, also check the alias position
    if (decl.kind === 'inherit' && decl.alias) {
      // The alias is in the range but after the nameRange
      // Check if the position is within the declaration range and matches the alias text
      if (decl.range.start.line === line && decl.range.end.line === line &&
          character >= decl.range.start.character && character <= decl.range.end.character) {
        // Verify it's actually on the alias by checking the source text
        const target = resolveInheritToClass(decl, table);
        if (target) return target;
      }
    }
  }
  return null;
}

/**
 * Resolve an inherit declaration to the target class declaration.
 * Returns the class Declaration if found, null otherwise.
 */
// Note: matches by name within the wired parent scope. Pike does not support
// multiple classes with the same name in the same scope, so the first match is correct.

function resolveInheritToClass(decl: Declaration, table: SymbolTable): Declaration | null {
  // Find the class scope that contains this inherit declaration
  const classScope = table.scopeById.get(decl.scopeId);
  if (!classScope) return null;

  // Find the inherited scope wired by wireInheritance
  const parentScope = classScope.parentId !== null
    ? table.scopeById.get(classScope.parentId)
    : null;
  if (!parentScope) return null;

  for (const parentDeclId of parentScope.declarations) {
    const parentDecl = table.declById.get(parentDeclId);
    if (parentDecl && parentDecl.kind === 'class' && parentDecl.name === decl.name) {
      return parentDecl;
    }
  }
  return null;
}

/**
 * Find a declaration by name that is visible at the given line.
 * Searches scopes from innermost to outermost.
 */
function findDeclInScopeAt(
  table: SymbolTable,
  name: string,
  line: number,
): Declaration | undefined {
  // Find the innermost scope containing this line.
  let bestScopeId: number | null = null;
  let bestDepth = -1;
  for (const scope of table.scopes) {
    if (line >= scope.range.start.line && line <= scope.range.end.line) {
      let depth = 0;
      let parentId = scope.parentId;
      while (parentId !== null) {
        depth++;
        const parent = table.scopeById.get(parentId);
        if (!parent) break;
        parentId = parent.parentId;
      }
      if (depth > bestDepth) {
        bestDepth = depth;
        bestScopeId = scope.id;
      }
    }
  }

  // Walk up scopes to find the declaration
  let scopeId = bestScopeId;
  while (scopeId !== null) {
    const scope = table.scopeById.get(scopeId);
    if (!scope) break;
    for (const declId of scope.declarations) {
      const decl = table.declById.get(declId);
      if (decl && decl.name === name) return decl;
    }
    scopeId = scope.parentId;
  }

  return undefined;
}

/**
 * Check if a declaration is a member (direct or inherited) of a class.
 *
 * classDecl.scopeId is the scope CONTAINING the class (e.g., file scope),
 * not the class body scope. We find the class body scope by looking for a
 * child scope with kind === 'class'.
 */
function isMemberOfClass(
  table: SymbolTable,
  targetDeclId: number,
  classDecl: Declaration,
): boolean {
  // Find the class body scope — it's a child scope with kind 'class'
  // whose range matches the class declaration's range.
  let classBodyScope = null;
  for (const scope of table.scopes) {
    if (scope.parentId === classDecl.scopeId && scope.kind === 'class' &&
        scope.range.start.line >= classDecl.range.start.line &&
        scope.range.end.line <= classDecl.range.end.line) {
      classBodyScope = scope;
      break;
    }
  }
  if (!classBodyScope) return false;

  // Direct member of the class body scope
  if (classBodyScope.declarations.includes(targetDeclId)) return true;

  // Inherited member
  for (const inheritedScopeId of classBodyScope.inheritedScopes) {
    const inheritedScope = table.scopeById.get(inheritedScopeId);
    if (inheritedScope?.declarations.includes(targetDeclId)) return true;
  }

  return false;
}

/**
 * Find all references to a declaration (for find-references).
 */
export function getReferencesTo(
  table: SymbolTable,
  line: number,
  character: number,
): Reference[] {
  // Find what's at this position
  let targetDeclId: number | null = null;

  // Is it a declaration?
  for (const decl of table.declarations) {
    const nr = decl.nameRange;
    if (nr.start.line === line && nr.end.line === line &&
        character >= nr.start.character && character <= nr.end.character) {
      targetDeclId = decl.id;
      break;
    }
  }

  // Is it a reference?
  if (targetDeclId === null) {
    for (const ref of table.references) {
      if (ref.loc.line === line && ref.loc.character === character) {
        targetDeclId = ref.resolvesTo;
        break;
      }
    }
  }

  if (targetDeclId === null) return [];

  // Collect all references that resolve to this declaration
  const results: Reference[] = [];
  for (const ref of table.references) {
    if (ref.resolvesTo === targetDeclId) {
      results.push(ref);
    }
  }

  // Fallback: include arrow/dot access references by name when they couldn't
  // be resolved to a specific declaration (untyped access). This ensures
  // rename finds call sites like `d->bark()` even when the arrow reference
  // has resolvesTo=null.
  //
  // US-004: filter by declared type when LHS type is known. If LHS resolves
  // to a class that does NOT contain the target declaration, exclude it.
  const targetDecl = table.declById.get(targetDeclId);
  if (targetDecl) {
    const targetName = targetDecl.name;
    for (const ref of table.references) {
      if (ref.resolvesTo === null && ref.name === targetName &&
          (ref.kind === 'arrow_access' || ref.kind === 'dot_access')) {
        if (ref.lhsName) {
          // Type-aware filtering: check if LHS's type contains the target.
          // Uses declaredType first, falls back to assignedType.
          const lhsDecl = findDeclInScopeAt(table, ref.lhsName, ref.loc.line);
          const lhsTypeName = lhsDecl ? resolveTypeName(lhsDecl) : null;
          if (lhsTypeName) {
            const typeClass = table.declarations.find(
              d => d.kind === 'class' && d.name === lhsTypeName,
            );
            if (typeClass) {
              // Check if target declaration is a member of the LHS's type class.
              const isMember = isMemberOfClass(table, targetDeclId, typeClass);
              if (!isMember) continue; // LHS type doesn't contain target — exclude
            }
          }
        }
        results.push(ref);
      }
    }
  }


  return results;
}
