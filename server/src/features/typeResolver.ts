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

import type { Declaration, SymbolTable } from "./symbolTable";
import type { WorkspaceIndex } from "./workspaceIndex";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TypeResolutionContext {
  table: SymbolTable;
  uri: string;
  index: WorkspaceIndex;
  stdlibIndex: Record<string, { signature: string; markdown: string }>;
}

const PRIMITIVE_TYPES = new Set([
  "void", "mixed", "zero", "int", "float", "string",
  "array", "mapping", "multiset", "object", "function", "program",
  "bool", "auto", "any",
]);

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
export function resolveType(
  typeName: string,
  context: TypeResolutionContext,
  depth = 0,
): TypeResolutionResult | null {
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
    return resolveQualifiedType(typeName, context, depth);
  }

  // 3. Cross-file class via inherit/import declarations
  const crossFileClass = resolveCrossFileType(typeName, context);
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
export function resolveMemberAccess(
  lhsName: string,
  memberName: string,
  lhsDecl: Declaration | null,
  context: TypeResolutionContext,
  depth = 0,
): Declaration | null {
  if (depth >= MAX_RESOLUTION_DEPTH) return null;

  // Use assignedType when declaredType is absent or a primitive like 'mixed'
  const typeName = (lhsDecl?.declaredType && !PRIMITIVE_TYPES.has(lhsDecl.declaredType))
    ? lhsDecl.declaredType
    : lhsDecl?.assignedType;
  if (typeName) {
    const result = resolveType(typeName, context, depth + 1);
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
function resolveQualifiedType(
  typeName: string,
  context: TypeResolutionContext,
  depth: number,
): TypeResolutionResult | null {
  const segments = typeName.split(".");
  if (segments.length < 2) return null;

  // Try resolving first segment as a module via WorkspaceIndex
  const moduleUri = context.index.resolveModule(segments[0], context.uri);
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
      id: -1,
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
function resolveCrossFileType(
  typeName: string,
  context: TypeResolutionContext,
): TypeResolutionResult | null {
  for (const decl of context.table.declarations) {
    if (decl.kind !== "inherit" && decl.kind !== "import") continue;

    // For string-literal inherits, skip (they resolve to files, not class names)
    if (decl.name.startsWith('"') && decl.name.endsWith('"')) continue;

    // Resolve this inherit/import to a target file
    const targetUri = context.index.resolveImport(decl.name, context.uri)
      ?? context.index.resolveInherit(decl.name, false, context.uri);
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
// Member lookup helpers
// ---------------------------------------------------------------------------

function findMemberInClass(
  memberName: string,
  classDecl: Declaration,
  table: SymbolTable,
): Declaration | null {
  // Find the class body scope — it's a child of the scope containing the class declaration,
  // and its range overlaps with the class declaration's name range.
  const classScope = table.scopes.find(s =>
    s.kind === 'class' && s.parentId === classDecl.scopeId &&
    posInRange(s.range, classDecl.nameRange.start),
  );
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
  const classScope = table.scopes.find(s =>
    s.kind === 'class' && s.parentId === classDecl.scopeId &&
    posInRange(s.range, classDecl.nameRange.start),
  );
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

function containsDecl(scope: { declarations: number[] }, decl: Declaration): boolean {
  return scope.declarations.includes(decl.id);
}

/** Check if a position falls within a range (inclusive start, exclusive end). */
function posInRange(range: { start: { line: number; character: number }; end: { line: number; character: number } }, pos: { line: number; character: number }): boolean {
  if (pos.line < range.start.line || pos.line > range.end.line) return false;
  if (pos.line === range.start.line && pos.character < range.start.character) return false;
  if (pos.line === range.end.line && pos.character > range.end.character) return false;
  return true;
}
