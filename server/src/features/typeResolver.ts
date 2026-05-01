/**
 * Type resolution for arrow/dot access (decision 0014).
 *
 * Resolves declared types to class declarations using tree-sitter symbol tables,
 * WorkspaceIndex, and the stdlib prefix index. No PikeWorker usage.
 *
 * Resolution chain:
 * 1. Same-file class declaration
 * 2. Cross-file class via inherit/import
 * 3. Qualified type (e.g., Stdio.File) via WorkspaceIndex + stdlib
 * 4. Stdlib type via prefix index
 */

import { PRIMITIVE_TYPES, resolveTypeName } from "./symbolTable";
import type { Declaration, Scope, SymbolTable } from "./symbolTable";
import { containsRange } from "./scopeBuilder";
import type { WorkspaceIndex } from "./workspaceIndex";

let nextSyntheticId = -1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TypeResolutionContext {
  table: SymbolTable;
  uri: string;
  index: WorkspaceIndex;
  stdlibIndex: Record<string, { signature: string; markdown: string }>;
  /**
   * Optional async type inferrer (typically PikeWorker.typeof_()).
   * Called when static type resolution fails — e.g., a variable declared
   * `mixed` with no assignedType. Returns the inferred type name or null.
   */
  typeInferrer?: (varName: string) => Promise<string | null>;
}


const MAX_RESOLUTION_DEPTH = 5;


export interface TypeResolutionResult {
  decl: Declaration;
  /** URI of the file containing the resolved declaration. */
  uri: string;
  /** SymbolTable that owns the resolved declaration. */
  table: SymbolTable;
}
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a declared type name to the Declaration of the target class/type.
 *
 * Returns:
 * - A Declaration if the type resolves to a known class
 * - null if the type is primitive, unknown, or resolution fails
 */
export async function resolveType(
  typeName: string,
  context: TypeResolutionContext,
  depth = 0,
): Promise<TypeResolutionResult | null> {
  if (depth >= MAX_RESOLUTION_DEPTH) return null;
  if (PRIMITIVE_TYPES.has(typeName)) return null;
  if (!typeName) return null;

  // 1. Same-file class
  const localClass = context.table.declarations.find(
    d => d.kind === "class" && d.name === typeName,
  );
  if (localClass) {
    return { decl: localClass, uri: context.uri, table: context.table };
  }

  // 2. Qualified type (e.g., "Stdio.File") — resolve first segment as module
  if (typeName.includes(".")) {
    return await resolveQualifiedType(typeName, context, depth);
  }

  // 3. Cross-file class via inherit/import declarations
  const crossFileClass = await resolveCrossFileType(typeName, context);
  if (crossFileClass) return crossFileClass;

  // 4. Stdlib type — check if "predef.<typeName>" has children in stdlib index
  // For stdlib types, we return null for the declaration — callers can
  // still enumerate members via the stdlib prefix index

  return null;
}

/**
 * Resolve an arrow/dot access reference to its target member declaration.
 *
 * For `obj->member`: resolves obj's declared type → class scope → find member
 * For `Module.member`: resolves Module → target file → find member
 */
export async function resolveMemberAccess(
  lhsName: string,
  memberName: string,
  lhsDecl: Declaration | null,
  context: TypeResolutionContext,
  depth = 0,
): Promise<Declaration | null> {
  if (depth >= MAX_RESOLUTION_DEPTH) return null;

  // Use assignedType when declaredType is absent or a primitive like 'mixed'
  let typeName = lhsDecl ? resolveTypeName(lhsDecl) : null;

  // If static type resolution yields nothing and a runtime inferrer is
  // available, ask Pike for the inferred type. This covers variables
  // declared `mixed` with no initializer pattern that extractInitializerType
  // can handle — e.g., function parameters or assignment-target variables.
  if (!typeName && lhsDecl && lhsDecl.name && context.typeInferrer) {
    if (lhsDecl.kind === 'variable' || lhsDecl.kind === 'parameter') {
      try {
        typeName = await context.typeInferrer(lhsDecl.name);
      } catch {
        // Worker unavailable or timed out — proceed without inferred type
      }
    }
  }

  if (typeName) {
    const result = await resolveType(typeName, context, depth + 1);
    if (result?.decl.kind === "class") {
      const member = findMemberInClass(memberName, result.decl, result.table);
      if (member) return member;

      // Check inherited scopes (already wired by wireInheritance)
      const memberInInherited = findMemberInInheritedScopes(
        memberName, result.decl, result.table,
      );
      if (memberInInherited) return memberInInherited;
    }
  }

  // If lhs is itself a class, look for members including inherited
  if (lhsDecl?.kind === 'class') {
    const member = findMemberInClass(memberName, lhsDecl, context.table);
    if (member) return member;

    // Check inherited scopes
    const inheritedMember = findMemberInInheritedScopes(memberName, lhsDecl, context.table);
    if (inheritedMember) return inheritedMember;
  }

  return null;
}

/**
 * Resolve a qualified type like "Stdio.File" through the workspace index and stdlib.
 */
async function resolveQualifiedType(
  typeName: string,
  context: TypeResolutionContext,
  depth: number,
): Promise<TypeResolutionResult | null> {
  const segments = typeName.split(".");
  if (segments.length < 2) return null;

  // Try resolving first segment as a module via WorkspaceIndex
  const moduleUri = await context.index.resolveModule(segments[0], context.uri);
  if (moduleUri) {
    const moduleTable = context.index.getSymbolTable(moduleUri);
    if (moduleTable) {
      for (let i = 1; i < segments.length; i++) {
        const classDecl = moduleTable.declarations.find(
          d => d.kind === "class" && d.name === segments[i],
        );
        if (classDecl) {
          if (i === segments.length - 1) {
            return { decl: classDecl, uri: moduleUri, table: moduleTable };
          }
        }
      }
    }
  }

  // Fallback: check stdlib index for predef.<typeName>
  const stdlibKey = "predef." + typeName;
  if (context.stdlibIndex[stdlibKey]) {
    // Build a synthetic Declaration for the stdlib type
    // so callers (e.g., completion) can enumerate members via the stdlib prefix index.
    const lastSegment = segments[segments.length - 1];
    const syntheticDecl: Declaration = {
      id: nextSyntheticId--,
      name: lastSegment,
      kind: "class",
      nameRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      scopeId: -1,
    };
    return {
      decl: syntheticDecl,
      uri: `stdlib://${typeName}`,
      table: { declarations: [], scopes: [], references: [], declById: new Map(), scopeById: new Map(), uri: `stdlib://${typeName}`, version: 0 },
    };
  }

  return null;
}

/**
 * Resolve a type name through cross-file inherit/import declarations.
 */
async function resolveCrossFileType(
  typeName: string,
  context: TypeResolutionContext,
): Promise<TypeResolutionResult | null> {
  for (const decl of context.table.declarations) {
    if (decl.kind !== "inherit" && decl.kind !== "import") continue;

    // For string-literal inherits, skip (they resolve to files, not class names)
    if (decl.name.startsWith('"') && decl.name.endsWith('"')) continue;

    // Resolve this inherit/import to a target file
    const targetUri = (await context.index.resolveImport(decl.name, context.uri))
      ?? await context.index.resolveInherit(decl.name, false, context.uri);
    if (!targetUri) continue;

    const targetTable = context.index.getSymbolTable(targetUri);
    if (!targetTable) continue;

    // Look for the class in the target file
    const classDecl = targetTable.declarations.find(
      d => d.kind === "class" && d.name === typeName,
    );
    if (classDecl) {
      return { decl: classDecl, uri: targetUri, table: targetTable };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Class scope lookup
// ---------------------------------------------------------------------------

/**
 * Find the class body scope that belongs to a class declaration.
 *
 * Uses `containsRange` to ensure the scope is *within* the declaration's
 * full range, which correctly disambiguates nested classes (multiple class
 * scopes may share the same parentId with overlapping ranges).
 */
export function findClassScope(table: SymbolTable, classDecl: Declaration): Scope | null {
  for (const scope of table.scopes) {
    if (scope.kind !== 'class') continue;
    if (scope.parentId !== classDecl.scopeId) continue;
    if (containsRange(classDecl.range, scope.range)) {
      return scope;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Member lookup helpers
// ---------------------------------------------------------------------------

function findMemberInClass(
  memberName: string,
  classDecl: Declaration,
  table: SymbolTable,
): Declaration | null {
  const classScope = findClassScope(table, classDecl);
  if (!classScope) return null;

  // Look for the member in the class scope's declarations
  for (const declId of classScope.declarations) {
    const decl = table.declById.get(declId);
    if (decl && decl.name === memberName) return decl;
  }

  return null;
}

/**
 * Find a member in inherited scopes of a class.
 */
function findMemberInInheritedScopes(
  memberName: string,
  classDecl: Declaration,
  table: SymbolTable,
): Declaration | null {
  const classScope = findClassScope(table, classDecl);
  if (!classScope) return null;

  for (const inheritedId of classScope.inheritedScopes) {
    const inheritedScope = table.scopeById.get(inheritedId);
    if (!inheritedScope) continue;

    for (const declId of inheritedScope.declarations) {
      const decl = table.declById.get(declId);
      if (decl && decl.name === memberName) return decl;
    }
  }

  return null;
}

/**
 * Collect all member declarations from a class and its inherited scopes.
 * Returns declarations from the class body scope plus all inherited scopes.
 */
export function collectClassMembers(table: SymbolTable, classDecl: Declaration): Declaration[] {
  const members: Declaration[] = [];
  const classScope = findClassScope(table, classDecl);
  if (!classScope) return members;

  for (const declId of classScope.declarations) {
    const decl = table.declById.get(declId);
    if (decl) members.push(decl);
  }

  for (const inheritedId of classScope.inheritedScopes) {
    const inheritedScope = table.scopeById.get(inheritedId);
    if (!inheritedScope) continue;
    for (const declId of inheritedScope.declarations) {
      const decl = table.declById.get(declId);
      if (decl) members.push(decl);
    }
  }

  return members;
}