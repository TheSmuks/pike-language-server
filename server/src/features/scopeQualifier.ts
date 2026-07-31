/**
 * What the text before a `::` names, and which inherit it selects.
 *
 * Pike's scope qualifier is binding. With `inherit "oa" : A; inherit "ob" : B;`
 * the compiler answers `A::shared()` and `B::shared()` with two different
 * functions, and rejects `A::only_b` with
 * `Undefined identifier A::only_b.` — verified against Pike 8.0.1116.
 *
 * The pure half of that rule lives here so both the symbol-table builder and
 * the cross-file resolver can apply it without importing each other.
 */

import type { Node } from 'web-tree-sitter';
import type { Declaration, Reference, SymbolTable } from './symbolTable';

/**
 * Pike's scope keywords, as the grammar emits them.
 *
 * They are ANONYMOUS tokens inside `inherit_specifier` — `predef::sizeof`
 * parses to `(inherit_specifier (predef) (::)) (identifier)` with no
 * `identifier` node for `predef` at all. Anything that looks for an identifier
 * to describe the qualifier therefore finds nothing on these.
 */
export const SCOPE_KEYWORDS = [
  'predef', 'global', 'this_program', 'this', 'local',
] as const;

export type ScopeKeyword = (typeof SCOPE_KEYWORDS)[number];

/** True when a qualifier is one of Pike's scope keywords rather than a name. */
export function isScopeKeyword(qualifier: string): qualifier is ScopeKeyword {
  return (SCOPE_KEYWORDS as readonly string[]).includes(qualifier);
}

/**
 * The qualifier text of an `inherit_specifier`.
 *
 * `""` for a bare `::`, which names everything the enclosing program inherits
 * and is a real answer rather than a missing one — so it must stay
 * distinguishable from "this reference has no qualifier at all".
 */
export function scopeQualifierText(scopeNode: Node): string {
  for (const child of scopeNode.children) {
    if (child.type === 'identifier') return child.text;
    if (child.type === 'string_literal') return child.text;
    if (isScopeKeyword(child.type)) return child.type;
  }
  return '';
}

/** Strip the quotes from a string-literal inherit path, if present. */
function unquote(text: string): string {
  const quoted = text.length >= 2 && text.startsWith('"') && text.endsWith('"');
  return quoted ? text.slice(1, -1) : text;
}

/**
 * The names a qualifier may legally use for an inherit.
 *
 * **An alias replaces the name; it does not add to it.** With
 * `inherit .mm.Session : parent;` Pike 8.0.1116 rejects `Session::timeout`:
 *
 *     No inherit or surrounding class Session.
 *
 * Drop the `: parent` and the same line prints `120`. So the path and its tail
 * are qualifiers only for an UNaliased inherit — accepting the tail either way
 * is how `Session::timeout` in Roxen's `HTTPClient.pmod` came back pointing at
 * `Protocols.HTTP.Query`, a class the expression does not name.
 *
 * For an unaliased inherit the path as written and its last segment both work,
 * so `inherit "etc/foo";` answers to `foo::`. A file extension is not part of
 * the name.
 */
export function inheritQualifierNames(decl: Declaration): string[] {
  if (decl.alias) return [decl.alias];

  const path = unquote(decl.name);
  const names = [path];

  // The extension goes before the split, or `"base.pike"` yields the segment
  // `pike` as its own name.
  const tail = path.replace(/\.(pike|pmod)$/, '')
    .split(/[./]/).filter(segment => segment.length > 0).pop();
  if (tail) names.push(tail);

  return names;
}

/** True when `decl` is the inherit a qualified `::` names. */
export function inheritMatchesQualifier(decl: Declaration, qualifier: string): boolean {
  if (decl.kind !== 'inherit') return false;
  return inheritQualifierNames(decl).includes(qualifier);
}

/**
 * How much of a program's inherit list a scope access may search.
 *
 * - `all` — a bare `::`, or `global::`/`this::`/`this_program::`/`local::`.
 *   Each of those names the enclosing program, and a program's members
 *   include everything it inherits.
 * - `named` — `A::name`. Only the inherit `A` names.
 * - `none` — `predef::name`. That is Pike's own top-level namespace; nothing
 *   in the workspace's inherit graph can answer it, and searching anyway
 *   produced a same-named local symbol instead of the builtin.
 */
export type InheritSearchScope = 'all' | 'named' | 'none';

/** Which inherits a reference's qualifier permits searching. */
export function inheritSearchScope(
  ref: { kind: string; scopeQualifier?: string },
): InheritSearchScope {
  if (ref.kind !== 'scope_access') return 'all';
  const qualifier = ref.scopeQualifier;
  if (!qualifier) return 'all';
  if (qualifier === 'predef') return 'none';
  return isScopeKeyword(qualifier) ? 'all' : 'named';
}

/**
 * The inherits a reference may reach through, in the file it is written in.
 *
 * The qualifier decides. `A::name` may reach only the inherit `A` names: Pike
 * answers `A::shared()` and `B::shared()` with different functions and rejects
 * `A::only_b` outright, so consulting the whole list turns a name Pike calls
 * undefined into a confident pointer at the wrong declaration.
 *
 * The restriction applies at the first hop only — `depth > 0` means the right
 * inherit has already been picked and its own chain is searched unqualified,
 * because `A::name` does find a `name` that A inherits.
 */
export function inheritsReachableBy(
  ref: Reference,
  table: SymbolTable,
  depth: number,
): Declaration[] {
  const all = table.declarations.filter(
    d => d.kind === "inherit" || d.kind === "import",
  );
  if (depth > 0) return all;

  const scope = inheritSearchScope(ref);
  if (scope === "all") return all;
  if (scope === "none") return [];
  return enclosingInherits(all, ref, table)
    .filter(d => inheritMatchesQualifier(d, ref.scopeQualifier!));
}

/**
 * Inherits declared by the reference's own program or by one enclosing it.
 *
 * A nested class DOES reach outward for a qualifier — with
 * `class Outer { inherit "pbase" : parent; class Nested { … parent::who() … } }`
 * Pike prints `INHERITED` — but only up its own lexical chain. A sibling
 * class's inherit is not a candidate, and file-wide matching made it one.
 *
 * Note this is the opposite of a bare `::`, which is program-local: the same
 * `Nested` calling `::who()` fails with `Undefined identifier ::who.`
 */
function enclosingInherits(
  candidates: Declaration[],
  ref: Reference,
  table: SymbolTable,
): Declaration[] {
  const visible = new Set<number>();
  for (const scope of table.scopes) {
    if (scope.kind !== "class" && scope.kind !== "file") continue;
    if (!scopeCovers(scope, ref.loc.line)) continue;
    for (const declId of scope.declarations) visible.add(declId);
  }
  if (visible.size === 0) return candidates;
  return candidates.filter(d => visible.has(d.id));
}

type LineRange = { range: { start: { line: number }; end: { line: number } } };

function scopeCovers(scope: LineRange, line: number): boolean {
  return scope.range.start.line <= line && line <= scope.range.end.line;
}
