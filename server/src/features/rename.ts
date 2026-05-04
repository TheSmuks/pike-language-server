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
// ---------------------------------------------------------------------------
// Pike reserved words — cannot be used as identifiers (rename targets/new names)
// Source: Pike lexer src/lexer.h keyword switch + Pike manual ch2-7
// ---------------------------------------------------------------------------

const PIKE_KEYWORDS = new Set([
  // Type keywords
  "array", "auto", "float", "function", "int", "mapping", "mixed",
  "multiset", "object", "program", "string", "void",

  // Declaration keywords
  "class", "constant", "enum", "extern", "import", "inherit", "lambda",
  "predef", "typedef", "typeof",

  // Modifier keywords
  "final", "inline", "local", "nomask", "optional", "private",
  "protected", "public", "static", "variant",

  // Control flow keywords
  "break", "case", "catch", "continue", "default", "do", "else",
  "for", "foreach", "goto", "if", "return", "sscanf", "switch", "while",

  // Special expression keywords
  "gauge", "global",

  // Double-underscore modifier keywords (Pike 9.0+)
  "__async__", "__attribute__", "__deprecated__", "__experimental__",
  "__generator__", "__weak__", "__unused__", "__unknown__",
]);

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

  // Reject stdlib/predef symbols
  if (protectedNames?.has(decl.name)) {
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

  // Cross-file references
  if (index) {
    const crossFileRefs = index.getCrossFileReferences(uri, line, character);
    for (const { uri: refUri, ref } of crossFileRefs) {
      // Skip the declaration site (already added)
      if (refUri === uri && ref.loc.line === decl.nameRange.start.line &&
          ref.loc.character === decl.nameRange.start.character) {
        continue;
      }

      // Type-aware filtering for arrow/dot access:
      // If we're renaming a member on class Dog, exclude cat->bark
      // where cat's type resolves to Cat, not Dog.
      if ((ref.kind === 'arrow_access' || ref.kind === 'dot_access') && ref.lhsName) {
        const refTable = index.getSymbolTable(refUri);
        if (refTable) {
          if (!await isReceiverTypeMatch(refTable, refUri, ref.lhsName, decl, table, index)) {
            continue;
          }
        }
        // If refTable is null (file not indexed), include conservatively
      }

      locations.push({
        uri: refUri,
        line: ref.loc.line,
        character: ref.loc.character,
        length: ref.name.length,
      });
    }
  }

  // Same-file references
  const refs = getReferencesTo(table, line, character);
  for (const ref of refs) {
    // Skip any ref that coincides with the declaration
    if (ref.loc.line === decl.nameRange.start.line &&
        ref.loc.character === decl.nameRange.start.character) {
      continue;
    }

    // Type-aware filtering for arrow/dot access:
    if ((ref.kind === 'arrow_access' || ref.kind === 'dot_access') && ref.lhsName && index) {
      if (!await isReceiverTypeMatch(table, uri, ref.lhsName, decl, table, index)) {
        continue;
      }
    }

    locations.push({
      uri,
      line: ref.loc.line,
      character: ref.loc.character,
      length: ref.name.length,
    });
  }

  return { locations, oldName };
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
  if (protectedNames?.has(decl.name)) return null;
  if (PIKE_KEYWORDS.has(decl.name)) return null;

  return {
    line: decl.nameRange.start.line,
    character: decl.nameRange.start.character,
    length: decl.name.length,
    name: decl.name,
  };
}
