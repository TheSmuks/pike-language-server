/**
 * Rename provider — workspace-wide symbol renaming.
 *
 * Decision 0016. Reuses existing reference resolution infrastructure:
 * - `getDefinitionAt()` for locating the declaration at cursor
 * - `getReferencesTo()` for same-file references
 * - `WorkspaceIndex.getCrossFileReferences()` for cross-file references
 *
 * The rename provider builds a `WorkspaceEdit` that replaces every occurrence
 * of the symbol (declaration + all references) with the new name.
 *
 * Protected symbol rejection: stdlib symbols (5,471 from the pre-built index),
 * predef builtins (283 C-level functions), syntax keywords, and ERROR nodes
 * cannot be renamed. The caller provides a `ReadonlySet<string>` of short names
 * derived from both indexes.
 */

import {
  type Declaration,
  type SymbolTable,
  getDefinitionAt,
  getReferencesTo,
} from "./symbolTable";
import type { WorkspaceIndex } from "./workspaceIndex";
import { resolveTypeName } from "./scope-helpers";
import { resolveType } from "./typeResolver";
import { PIKE_KEYWORDS } from "./pikeKeywords";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const PIKE_IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Validate that a name is a legal Pike identifier and not a reserved word.
 * Returns an error message if invalid, or null if valid.
 */
export function validateRenameName(newName: string): string | null {
  if (!newName) {
    return "New name cannot be empty.";
  }
  if (!PIKE_IDENTIFIER_RE.test(newName)) {
    return `"${newName}" is not a valid Pike identifier.`;
  }
  if (PIKE_KEYWORDS.has(newName)) {
    return `"${newName}" is a Pike reserved word.`;
  }
  // Pike lexer treats any __foo__ pattern as reserved
  if (/^__[a-z].*__$/.test(newName)) {
    return `"${newName}" matches the Pike reserved pattern (__prefix__suffix__).`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single rename edit location. */
export interface RenameLocation {
  uri: string;
  line: number;
  character: number;
  /** Length of the old name (to build the replacement range). */
  length: number;
}

/** Result of a rename operation. */
export interface RenameResult {
  locations: RenameLocation[];
  oldName: string;
}

/** Result of a prepare rename operation. */
export interface PrepareRenameResult {
  line: number;
  character: number;
  length: number;
  name: string;
}

/** Set of symbol short names that cannot be renamed (stdlib + predef). */
export type ProtectedNames = ReadonlySet<string>;

/**
 * Is this declaration protected from rename by a stdlib/predef name collision?
 *
 * Only *file-scope* declarations qualify. A file-scope symbol shadows the
 * predef of the same name and propagates to dependent files by name, so
 * renaming one can reach call sites the rename engine cannot prove belong to
 * it. Locals, parameters, and class members cannot shadow a predef across
 * files — locals resolve within their own scope, and member references are
 * filtered by receiver type — so a user variable called `name`, `count`,
 * `size`, `data`, `index`… must stay renameable. Roughly 3,700 names are in
 * `protectedNames`, which made this check far too broad when applied to every
 * declaration kind.
 */
function isProtectedFromRename(
  table: SymbolTable,
  decl: Declaration,
  protectedNames?: ProtectedNames,
): boolean {
  if (!protectedNames?.has(decl.name)) return false;
  return table.scopeById.get(decl.scopeId)?.kind === 'file';
}

// ---------------------------------------------------------------------------
// Type-aware rename filtering
// ---------------------------------------------------------------------------

/**
 * Find the class that owns a member declaration using the origin table.
 * Class declarations have a scopeId that is the file scope, while class body
 * scopes have parentId = class decl's scopeId. So we find the class body scope
 * (whose parentId contains targetDecl) and then find the class whose scopeId
 * matches the body scope's parentId.
 */
function findOwningClass(
  targetDecl: Declaration,
  originTable: SymbolTable,
): { className: string } | null {
  // Find the class body scope that contains targetDecl
  const classBodyScope = originTable.scopes.find(
    s => s.kind === 'class' && s.declarations.includes(targetDecl.id),
  );
  if (!classBodyScope) return null;

  // The class declaration's scopeId is the class body scope's parent
  const classDecl = originTable.declarations.find(
    d => d.kind === 'class' && d.scopeId === classBodyScope.parentId,
  );
  if (!classDecl) return null;

  return { className: classDecl.name };
}

/**
 * Check if an arrow/dot access receiver matches the declaration's class.
 *
 * When renaming Dog.bark(), we want to include d->bark where d is a Dog,
 * but exclude c->bark where c is a Cat (even if Cat also has bark()).
 *
 * Resolution strategy:
 * 1. Find the class that the LHS variable's type resolves to (from the ref's file)
 * 2. Find the class that the target declaration belongs to (from the origin file)
 * 3. Compare by class name — IDs are file-local and not comparable across files
 *
 * If resolution fails (unknown type, unresolvable), we include the
 * reference — false negatives (missing renames) are worse than false
 * positives (extra renames that the user can reject in preview).
 *
 * @param refTable - Symbol table of the file containing the reference
 * @param originTable - Symbol table of the file containing the declaration
 */
async function isReceiverTypeMatch(
  refTable: SymbolTable,
  refUri: string,
  lhsName: string,
  targetDecl: Declaration,
  originTable: SymbolTable,
  index: WorkspaceIndex,
): Promise<boolean> {
  // Find the LHS variable declaration
  const lhsDecl = refTable.declarations.find(
    d => d.name === lhsName && (d.kind === 'variable' || d.kind === 'parameter'),
  );
  if (!lhsDecl) return true; // Unknown LHS — include conservatively

  const lhsTypeName = resolveTypeName(lhsDecl);
  if (!lhsTypeName) return true; // No type info — include conservatively

  // Resolve the LHS type to a class declaration
  const lhsTypeResult = await resolveType(lhsTypeName, {
    table: refTable,
    uri: refUri,
    index,
    stdlibIndex: {}, // Stdlib types don't have user-defined members
  });

  if (!lhsTypeResult) return true; // Can't resolve — include conservatively

  // Handle class renames: check if lhs type IS the class being renamed
  if (targetDecl.kind === 'class') {
    return lhsTypeResult.decl.name === targetDecl.name;
  }

  // For member renames: find the class that owns targetDecl
  const targetClass = findOwningClass(targetDecl, originTable);
  if (!targetClass) return true; // Can't determine owning class

  // Compare by class name — IDs are file-local and not comparable across files
  return lhsTypeResult.decl.name === targetClass.className;
}


// ---------------------------------------------------------------------------
// Rename logic
// ---------------------------------------------------------------------------
/**
 * Find all locations that should be renamed for the symbol at the given position.
 *
 * 1. Resolve the declaration at cursor via `getDefinitionAt()`
 * 2. If cross-file, use `WorkspaceIndex.getCrossFileReferences()`
 * 3. Otherwise, use `getReferencesTo()` for same-file
 * 4. Build the list of all locations (declaration + all references)
 */
export async function getRenameLocations(
  table: SymbolTable,
  uri: string,
  line: number,
  character: number,
  index: WorkspaceIndex | null,
  protectedNames?: ProtectedNames,
): Promise<RenameResult | null> {
  // Find the declaration at cursor
  const decl = getDefinitionAt(table, line, character);
  if (!decl) {
    return null;
  }
  // Also guarded here, not only in prepareRename: a client is free to send
  // textDocument/rename without ever calling prepareRename, and this request
  // is the destructive one.
  if (namesAnotherDeclaration(decl)) {
    return null;
  }
  // The cursor must be ON an occurrence of the symbol being renamed. At
  // `inherit Zoinker;` getDefinitionAt resolves through to the class, whose
  // occurrences do not include the inherit clause — so the edits would rewrite
  // the class and leave the clause dangling. prepareRename already declines
  // here; without this, the two requests disagree and a client that skips
  // prepareRename corrupts the file.
  if (!occurrenceAt(table, decl, line, character)) {
    return null;
  }

  // Reject stdlib/predef symbols shadowed at file scope
  if (isProtectedFromRename(table, decl, protectedNames)) {
    return null;
  }
  const locations: RenameLocation[] = [];
  const oldName = decl.name;

  // Declaration site
  locations.push({
    uri,
    line: decl.nameRange.start.line,
    character: decl.nameRange.start.character,
    length: oldName.length,
  });

  // Collect cross-file and same-file references
  if (index) await collectCrossFileReferences(locations, decl, table, uri, index);
  await collectSameFileReferences(locations, decl, table, uri, index);

  return { locations: dedupeLocations(locations), oldName };
}

/**
 * Drop duplicate edits at the same position.
 *
 * `getCrossFileReferences()` already returns same-file references, and
 * `collectSameFileReferences()` then collects them again — so every same-file
 * reference lands in the list twice whenever a workspace index is present.
 * Both paths apply the same receiver-type filter, so the duplicates are exact
 * and dropping them changes only the count. Emitting them would produce a
 * WorkspaceEdit with overlapping ranges, which clients either reject or apply
 * twice (corrupting the text).
 */
function dedupeLocations(locations: RenameLocation[]): RenameLocation[] {
  const unique: RenameLocation[] = [];
  for (const loc of locations) {
    const duplicate = unique.some(
      u => u.uri === loc.uri && u.line === loc.line && u.character === loc.character,
    );
    if (!duplicate) unique.push(loc);
  }
  return unique;
}

async function collectCrossFileReferences(
  locations: RenameLocation[],
  decl: Declaration,
  table: SymbolTable,
  uri: string,
  index: WorkspaceIndex,
): Promise<void> {
  const crossFileRefs = index.getCrossFileReferences(uri, decl.nameRange.start.line, decl.nameRange.start.character);
  for (const { uri: refUri, ref } of crossFileRefs) {
    if (refUri === uri && ref.loc.line === decl.nameRange.start.line &&
        ref.loc.character === decl.nameRange.start.character) continue;

    if ((ref.kind === 'arrow_access' || ref.kind === 'dot_access') && ref.lhsName) {
      const refTable = index.getSymbolTable(refUri);
      if (refTable && !await isReceiverTypeMatch(refTable, refUri, ref.lhsName, decl, table, index)) continue;
    }

    locations.push({ uri: refUri, line: ref.loc.line, character: ref.loc.character, length: ref.name.length });
  }
}

async function collectSameFileReferences(
  locations: RenameLocation[],
  decl: Declaration,
  table: SymbolTable,
  uri: string,
  index: WorkspaceIndex | null,
): Promise<void> {
  const refs = getReferencesTo(table, decl.nameRange.start.line, decl.nameRange.start.character);
  for (const ref of refs) {
    if (ref.loc.line === decl.nameRange.start.line && ref.loc.character === decl.nameRange.start.character) continue;

    if ((ref.kind === 'arrow_access' || ref.kind === 'dot_access') && ref.lhsName && index) {
      if (!await isReceiverTypeMatch(table, uri, ref.lhsName, decl, table, index)) continue;
    }

    locations.push({ uri, line: ref.loc.line, character: ref.loc.character, length: ref.name.length });
  }
}

/**
 * Build a LSP WorkspaceEdit from rename locations.
 *
 * Groups locations by URI and creates TextEdits for each.
 */
export function buildWorkspaceEdit(
  locations: RenameLocation[],
  newName: string,
): { changes: Record<string, Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }>> } {
  const changes: Record<string, Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }>> = {};

  for (const loc of locations) {
    if (!changes[loc.uri]) {
      changes[loc.uri] = [];
    }
    changes[loc.uri].push({
      range: {
        start: { line: loc.line, character: loc.character },
        end: { line: loc.line, character: loc.character + loc.length },
      },
      newText: newName,
    });
  }

  return { changes };
}

// ---------------------------------------------------------------------------
// Prepare rename
// ---------------------------------------------------------------------------

/**
 * An inherit/import declaration names a class it does not own.
 *
 * Renaming through one produces edits at the inherit clause but none at the
 * class declaration itself, leaving source that no longer compiles. Renaming
 * the class is legitimate — driven from the class, not from a clause that
 * merely references it.
 */
function namesAnotherDeclaration(decl: Declaration): boolean {
  return decl.kind === 'inherit' || decl.kind === 'import';
}

/**
 * Determine if the symbol at the given position can be renamed.
 * Returns the range and placeholder for the rename UI, or null.
 *
 * Rejects: positions with no symbol, stdlib/predef symbols, Pike keywords.
 */
export function prepareRename(
  table: SymbolTable,
  line: number,
  character: number,
  protectedNames?: ProtectedNames,
): PrepareRenameResult | null {
  const decl = getDefinitionAt(table, line, character);
  if (!decl) return null;
  if (namesAnotherDeclaration(decl)) return null;
  if (isProtectedFromRename(table, decl, protectedNames)) return null;
  if (PIKE_KEYWORDS.has(decl.name)) return null;

  // LSP requires the returned range to CONTAIN the requested position: clients
  // use it to pre-select the text being renamed. Returning the declaration's
  // range instead highlights the wrong span whenever rename is invoked from a
  // reference, and — because getDefinitionAt resolves `this` to the enclosing
  // class — it turned a cursor on `this` into an offer to rename that class.
  // The keyword guard above cannot catch that: it sees the resolved name.
  const occurrence = occurrenceAt(table, decl, line, character);
  if (!occurrence) return null;

  return {
    line: occurrence.line,
    character: occurrence.character,
    length: decl.name.length,
    name: decl.name,
  };
}

/**
 * Locate the occurrence of `decl` that the cursor sits inside — the
 * declaration itself or one of its references.
 *
 * Returns null when the position is not on an occurrence of this symbol at
 * all, which is how a cursor on `this` (whose declaration is the enclosing
 * class, somewhere else entirely) is rejected.
 */
function occurrenceAt(
  table: SymbolTable,
  decl: Declaration,
  line: number,
  character: number,
): { line: number; character: number } | null {
  const covers = (start: { line: number; character: number }) =>
    start.line === line &&
    character >= start.character &&
    character <= start.character + decl.name.length;

  if (covers(decl.nameRange.start)) {
    return { line: decl.nameRange.start.line, character: decl.nameRange.start.character };
  }

  for (const ref of getReferencesTo(table, line, character)) {
    if (ref.name === decl.name && covers(ref.loc)) {
      return { line: ref.loc.line, character: ref.loc.character };
    }
  }
  return null;
}
