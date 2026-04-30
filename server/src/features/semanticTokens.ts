/**
 * Semantic token type and modifier mapping (decision 0020).
 *
 * Maps Pike's DeclKind values to LSP SemanticTokenTypes and
 * SemanticTokenModifiers, following the LSP 3.16+ semantic tokens spec.
 *
 * The legend ordering (tokenTypes and tokenModifiers arrays) determines the
 * numeric indices emitted in the delta-encoded token array. Once published,
 * these indices are a wire contract — they MUST NOT change without a
 * capability renegotiation.
 *
 * Token production (consuming the symbol table to emit tokens) is US-013.
 * LSP handler registration is US-014.
 */

import type { Declaration, SymbolTable } from "./symbolTable";

// ---------------------------------------------------------------------------
// Token type legend
// ---------------------------------------------------------------------------

/**
 * Ordered list of semantic token types. The index of each entry is its
 * numeric type ID in the token data array.
 *
 * Chosen to cover all DeclKind values with standard LSP token types.
 * 'namespace' covers both `inherit` and `import` declarations.
 */
export const TOKEN_TYPES = [
  "class",       // 0 — class declarations
  "enum",        // 1 — enum declarations
  "enumMember",  // 2 — enum members
  "function",    // 3 — top-level and nested functions
  "method",      // 4 — class methods (functions inside a class scope)
  "variable",    // 5 — local and top-level variables, constants (with readonly modifier)
  "parameter",   // 6 — function/method parameters
  "type",        // 7 — typedef declarations
  "namespace",   // 8 — inherit and import declarations
] as const;

export type TokenTypeId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

// ---------------------------------------------------------------------------
// Token modifier legend
// ---------------------------------------------------------------------------

/**
 * Ordered list of semantic token modifiers. The index of each entry is the
 * bit position in the modifier bitmask.
 */
export const TOKEN_MODIFIERS = [
  "declaration",  // 0 — declaration site (as opposed to reference)
  "definition",   // 1 — definition site (same as declaration for Pike)
  "readonly",     // 2 — constant declarations
  "static",       // 3 — class-level (non-instance) declarations
  "deprecated",   // 4 — marked @deprecated in AutoDoc
] as const;

export type TokenModifierId = 0 | 1 | 2 | 3 | 4;

// ---------------------------------------------------------------------------
// DeclKind → TokenType mapping
// ---------------------------------------------------------------------------

const DECL_KIND_TO_TOKEN_TYPE: Record<string, TokenTypeId> = {
  class:      0,  // "class"
  enum:       1,  // "enum"
  enum_member: 2, // "enumMember"
  function:   3,  // "function" — may be promoted to "method" based on scope
  variable:   5,  // "variable"
  constant:   5,  // "variable" + readonly modifier
  typedef:    7,  // "type"
  parameter:  6,  // "parameter"
  inherit:    8,  // "namespace"
  import:     8,  // "namespace"
};

/**
 * Resolve a DeclKind to a semantic token type index.
 *
 * For `function` declarations inside a class scope, callers should use
 * `methodTypeId` (4) instead of the function type (3). The scope context
 * is not available here — that decision belongs to the token producer (US-013).
 */
export function tokenTypeForDeclKind(kind: string): TokenTypeId | undefined {
  return DECL_KIND_TO_TOKEN_TYPE[kind];
}

/** Token type ID for class methods — functions inside a class scope. */
export const METHOD_TYPE_ID: TokenTypeId = 4;

// ---------------------------------------------------------------------------
// DeclKind → TokenModifier mapping
// ---------------------------------------------------------------------------

/**
 * Compute the modifier bitmask for a declaration.
 *
 * Returns a number where each set bit corresponds to a TOKEN_MODIFIERS entry.
 */
export function tokenModifiersForDecl(
  kind: string,
  options?: {
    /** Whether this declaration is inside a class scope (static context). */
    isClassScope?: boolean;
    /** Whether AutoDoc marks this declaration as deprecated. */
    isDeprecated?: boolean;
  },
): number {
  let modifiers = 0;

  // All declarations from the symbol table are definition sites
  modifiers |= (1 << 0); // declaration
  modifiers |= (1 << 1); // definition

  // Constants get the readonly modifier
  if (kind === "constant") {
    modifiers |= (1 << 2); // readonly
  }

  // Class-level (non-instance) declarations get the static modifier
  if (options?.isClassScope) {
    modifiers |= (1 << 3); // static
  }

  // Deprecated from AutoDoc
  if (options?.isDeprecated) {
    modifiers |= (1 << 4); // deprecated
  }

  return modifiers;
}

// ---------------------------------------------------------------------------
// Legend — for the server's SemanticTokensLegend capability response
// ---------------------------------------------------------------------------

/**
 * The SemanticTokensLegend to advertise in the server capabilities.
 *
 * This object must be returned as part of the `semanticTokensProvider`
 * capability during initialize. The client uses it to decode the numeric
 * token data into human-readable types and modifiers.
 */
export const SEMANTIC_TOKENS_LEGEND: { tokenTypes: string[]; tokenModifiers: string[] } = {
  tokenTypes: [...TOKEN_TYPES],
  tokenModifiers: [...TOKEN_MODIFIERS],
};

// ---------------------------------------------------------------------------
// Token production (US-013)
// ---------------------------------------------------------------------------

/** A single semantic token before delta encoding. */
export interface SemanticToken {
  line: number;
  character: number;
  length: number;
  typeId: TokenTypeId;
  modifiers: number;
}

/**
 * Check whether a declaration's scope is a class scope.
 * Walks up the scope chain to find the nearest class scope.
 */
function isInClassScope(decl: Declaration, table: SymbolTable): boolean {
  let scopeId: number | null = decl.scopeId;
  while (scopeId !== null) {
    const scope = table.scopeById.get(scopeId);
    if (!scope) break;
    if (scope.kind === 'class') return true;
    // Stop at function scope boundary — methods inside functions
    // are not direct class members.
    if (scope.kind === 'function' || scope.kind === 'lambda') break;
    scopeId = scope.parentId;
  }
  return false;
}

/**
 * Produce semantic tokens from the symbol table.
 *
 * Walks all declarations and references, producing one token per entry.
 * Tokens are NOT delta-encoded — callers must apply delta encoding
 * before sending to the client.
 *
 * Token ordering: sorted by (line, character) ascending.
 */
export function produceSemanticTokens(table: SymbolTable): SemanticToken[] {
  const tokens: SemanticToken[] = [];

  // --- Declarations ---
  for (const decl of table.declarations) {
    const typeId = resolveDeclTokenType(decl, table);
    if (typeId === undefined) continue;

    const modifiers = tokenModifiersForDecl(decl.kind, {
      isClassScope: isInClassScope(decl, table) && decl.kind !== 'class',
    });

    // Name length from nameRange
    const length = decl.nameRange.end.character - decl.nameRange.start.character;
    if (length <= 0) continue;

    tokens.push({
      line: decl.nameRange.start.line,
      character: decl.nameRange.start.character,
      length,
      typeId,
      modifiers,
    });
  }

  // --- References ---
  for (const ref of table.references) {
    // Skip references that resolve to declarations — those are
    // redundant with declaration tokens. Only produce tokens for
    // unresolved references that still carry useful type info.
    // (LSP clients handle reference highlighting separately.)
    if (ref.resolvesTo !== null) continue;

    // Unresolved arrow/dot access — skip (no meaningful token type)
    if (ref.kind === 'arrow_access' || ref.kind === 'dot_access') continue;

    // Unresolved scope access — skip
    if (ref.kind === 'scope_access') continue;

    // Unresolved type_ref — produce as 'type' token
    if (ref.kind === 'type_ref') {
      tokens.push({
        line: ref.loc.line,
        character: ref.loc.character,
        length: ref.name.length,
        typeId: 7, // 'type'
        modifiers: 0,
      });
      continue;
    }

    // Other unresolved identifiers — produce as 'variable' token
    // This covers cases like stdlib/predef references that aren't in the symbol table.
    if (ref.name.length > 0) {
      tokens.push({
        line: ref.loc.line,
        character: ref.loc.character,
        length: ref.name.length,
        typeId: 5, // 'variable'
        modifiers: 0,
      });
    }
  }

  // Sort by position (line, then character)
  tokens.sort((a, b) => {
    if (a.line !== b.line) return a.line - b.line;
    return a.character - b.character;
  });

  return tokens;
}

/**
 * Resolve the token type for a declaration.
 * Promotes 'function' to 'method' when inside a class scope.
 */
function resolveDeclTokenType(decl: Declaration, table: SymbolTable): TokenTypeId | undefined {
  const base = tokenTypeForDeclKind(decl.kind);
  if (base === undefined) return undefined;

  // Promote function → method when inside a class scope
  if (decl.kind === 'function' && base === 3 && isInClassScope(decl, table)) {
    return METHOD_TYPE_ID;
  }

  return base;
}

// ---------------------------------------------------------------------------
// Delta encoding
// ---------------------------------------------------------------------------

/**
 * Delta-encode a sorted array of semantic tokens into the LSP wire format.
 *
 * The output is a flat array: [deltaLine, deltaStartChar, length, typeId, modifiers, ...]
 * Each token's position is relative to the previous token.
 */
export function deltaEncodeTokens(tokens: SemanticToken[]): number[] {
  const result: number[] = [];
  let prevLine = 0;
  let prevChar = 0;

  for (const token of tokens) {
    const deltaLine = token.line - prevLine;
    const deltaChar = deltaLine === 0
      ? token.character - prevChar
      : token.character;

    result.push(deltaLine, deltaChar, token.length, token.typeId, token.modifiers);

    prevLine = token.line;
    prevChar = token.character;
  }

  return result;
}