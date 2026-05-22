/**
 * Snippet generation helpers for Pike LSP completion.
 *
 * Extracted from completion-items.ts to keep it under 500 lines.
 * Re-exported by completion-items.ts so existing imports continue to work.
 */

import {
  type SymbolTable,
  type Declaration,
  getDeclarationsInScope,
} from "./symbolTable";
import { stripScopeWrapper } from "../util/stripScope";

// ---------------------------------------------------------------------------
// Snippet parameter extraction
// ---------------------------------------------------------------------------

/**
 * Extract parameter placeholders from a Pike function type string.
 *
 * Input:  "function(string, int:void)" or "function(void)"
 * Output: "${1:string}, ${2:int}" or "" (for void/no params)
 * Returns null if the type string is not a function type.
 */
export function extractParamsFromType(typeStr: string): string | null {
  // Match function(params:return_type) pattern
  const match = typeStr.match(/^function\s*\(([^)]*)\)/);
  if (!match) return null;

  const paramList = match[1].trim();
  if (!paramList || paramList === "void" || paramList === "...") {
    return "";
  }

  const parts = paramList.split(",").map(p => p.trim());
  // Filter out trailing return type separator (":void" etc.)
  // Pike function types: function(param1, param2 : return_type)
  const colonIdx = parts.findIndex(p => p.startsWith(":"));
  let paramTypes: string[];
  if (colonIdx !== -1) {
    paramTypes = parts.slice(0, colonIdx);
  } else {
    // Check if the last part looks like ":type" attached to previous param
    const lastPart = parts[parts.length - 1];
    if (lastPart.includes(":")) {
      // The last element contains ":returnType" — strip it
      const beforeColon = lastPart.split(":")[0].trim();
      paramTypes = [...parts.slice(0, -1), beforeColon];
    } else {
      paramTypes = parts;
    }
  }

  // Generate snippet tab stops: ${1:type1}, ${2:type2}, ...
  const placeholders = paramTypes
    .filter(p => p.length > 0)
    .map((p, i) => `\${${i + 1}:${p}}`);

  return placeholders.join(", ");
}

/**
 * Extract constructor parameter placeholders for a class declaration.
 *
 * Looks up the class scope, finds the `create()` method, and extracts
 * its parameters as snippet tab stops.
 * Returns null if the class has no create() method or it has no parameters.
 */
export function extractConstructorParams(classDecl: Declaration, table: SymbolTable): string | null {
  // Find the class scope that overlaps with the class declaration range
  const classScope = table.scopes.find(
    s => s.kind === "class" && rangesOverlap(s.range, classDecl.range),
  );
  if (!classScope) return null;

  // Find the create() method declaration in the class scope (or inherited)
  const createDecl = findCreateMethod(table, classScope);
  if (!createDecl || !createDecl.declaredType) return null;

  const params = extractParamsFromType(createDecl.declaredType);
  return params; // null if not a function type, "" if void/no-params
}

/**
 * Walk inheritance chain to find a create() method.
 */
function findCreateMethod(table: SymbolTable, scope: { id: number }): Declaration | null {
  const decls = getDeclarationsInScope(table, scope.id);
  const create = decls.find(d => d.name === "create" && (d.kind === "method" || d.kind === "function"));
  if (create) return create;

  // Check inherited scopes
  for (const decl of decls) {
    if (decl.kind === "inherit" && decl.scopeId != null) {
      const inherited = findCreateMethod(table, { id: decl.scopeId });
      if (inherited) return inherited;
    }
  }
  return null;
}

/**
 * Check if two ranges overlap (used to match class scope to class declaration).
 */
function rangesOverlap(a: { start: { line: number; character: number }; end: { line: number; character: number } }, b: { start: { line: number; character: number }; end: { line: number; character: number } }): boolean {
  if (a.start.line > b.end.line || (a.start.line === b.end.line && a.start.character > b.end.character)) return false;
  if (a.end.line < b.start.line || (a.end.line === b.start.line && a.end.character < b.start.character)) return false;
  return true;
}

/**
 * Extract parameter placeholders from a predef builtin type string.
 *
 * Predef signatures look like:
 *   "function(string, int:void)"
 *   "scope(0, function(string, int | string, void | int : int) | function(...))"
 *   "function( : int)"          (no params)
 *
 * Takes the first overload, strips scope wrapper, extracts param types.
 */
export function extractParamsFromPredefType(raw: string): string | null {
  let sig = stripScopeWrapper(raw);
  // Take the first overload if multiple (separated by " | function")
  const overloadSplit = sig.split(" | function");
  sig = overloadSplit[0].trim();
  // Strip leading "function" keyword
  if (sig.startsWith("function")) sig = sig.slice(8).trim();

  // Now parse function(params : returnType) or function(params)
  const match = sig.match(/^\(([^)]*)\)/);
  if (!match) return null;

  const paramList = match[1].trim();
  if (!paramList || paramList === "void" || paramList === "...") return "";

  // Split by comma, stop at colon (return type separator)
  const parts = paramList.split(",").map(p => p.trim());
  const colonIdx = parts.findIndex(p => p.startsWith(":"));
  const paramTypes = colonIdx !== -1
    ? parts.slice(0, colonIdx)
    : parts;

  // Filter out empty and produce tab stops
  const placeholders = paramTypes
    .filter(p => p.length > 0)
    .map((p, i) => `\${${i + 1}:${p}}`);

  return placeholders.join(", ");
}

/**
 * Extract parameter placeholders from a stdlib C-style signature.
 *
 * Stdlib signatures look like:
 *   "mixed get_value(array(string) argv, mapping(string : string) env, int|string previous)"
 *   "string __sprintf()"
 *   "inherit Opt"
 *
 * Parses the param list to extract param names (or types if no names).
 */
export function extractParamsFromStdlibSignature(signature: string): string | null {
  // Match returnType functionName(params) pattern
  const match = signature.match(/\(([^)]*)\)\s*$/);
  if (!match) return null;

  const paramList = match[1].trim();
  if (!paramList) return "";

  // Split params by comma, handling nested parens/angles
  const paramParts = splitParams(paramList);
  if (paramParts.length === 0) return "";

  const placeholders: string[] = [];
  for (let i = 0; i < paramParts.length; i++) {
    const part = paramParts[i].trim();
    if (!part || part === "void") continue;
    // Try to extract the param name (last word after type)
    const nameMatch = part.match(/(\w+)\s*$/);
    const label = nameMatch ? nameMatch[1] : part;
    placeholders.push(`\${${i + 1}:${label}}`);
  }

  if (placeholders.length === 0) return "";
  return placeholders.join(", ");
}

/**
 * Split a parameter list by commas, respecting nested parens and angles.
 */
function splitParams(paramList: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of paramList) {
    if (ch === "(" || ch === "<" || ch === "[") depth++;
    else if (ch === ")" || ch === ">" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/**
 * Clean a predef builtin signature for display.
 * Removes scope wrappers and simplifies overloaded signatures.
 */
export function cleanPredefSignature(raw: string): string {
  let sig = stripScopeWrapper(raw);
  // Take the first overload if multiple
  const parts = sig.split(" | function");
  sig = parts[0].trim();
  // Remove leading "function" if present
  if (sig.startsWith("function")) {
    sig = sig.slice(8).trim();
  }
  return sig || raw;
}
