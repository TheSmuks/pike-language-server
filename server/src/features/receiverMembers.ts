/**
 * Which receivers can own a member at all.
 *
 * Split out of typeResolver.ts at the 500-line TigerStyle limit. Pure
 * predicates over a Reference and its table — no resolution, no I/O — shared
 * by the cross-file resolver and by hover so the two cannot disagree about
 * what a mapping is.
 */

import type { Reference, SymbolTable } from "./symbolTable";

/**
 * Receiver types for which `receiver->member` names no declaration at all.
 *
 * Verified one at a time against Pike 8.0.1116:
 *
 * - `mapping m; m->foo` is `m["foo"]` — a value lookup that prints `0` for a
 *   missing key. There is nothing declared anywhere to point at.
 * - `multiset ms; ms->a` is a membership test and prints `1`.
 * - `string s; s->size` and `float f; f->foo` do not compile:
 *   `Indexing on illegal type.`
 * - `int i; i->foo` fails at run time: `Indexing the integer 1 with unknown
 *   method "foo"`.
 *
 * **`array` is deliberately absent.** `array(Obj) as; as->twice()` automaps and
 * returns one result per element, so an array of a class does have members —
 * the element's. Suppressing it would trade a wrong answer for a missing one.
 */
const MEMBERLESS_RECEIVER_TYPE = /^(mapping|multiset|string|int|float)\b/;

/**
 * True when the cross-file fallback must not answer this access.
 *
 * That fallback searches the inherit chain by bare NAME, with no knowledge of
 * the receiver, so `pkt->ip` on a mapping came back pointing at an `ip` in
 * `Stdio.pmod` — 1,747 such answers across Roxen 6.1, every one of them a
 * confident pointer at a declaration the expression cannot be referring to.
 */
export function receiverNamesNoMember(ref: Reference, table: SymbolTable): boolean {
  if (ref.kind !== "arrow_access" && ref.kind !== "dot_access") return false;
  if (!ref.lhsName) return false;

  const lhsDecl = table.declarations.find(
    d => d.name === ref.lhsName && (d.kind === "variable" || d.kind === "parameter"),
  );

  // A `.` whose left side is not a variable is a MODULE PATH, and the member
  // belongs to that module or to nothing. `Image.JPEG.encode` and
  // `ADT.Table.ASCII.encode` both came back as Roxen's own `encode` in
  // `Variable.pmod`, found by name in an inherit chain neither expression
  // mentions — the module-path resolver above is the only tier entitled to
  // answer these, and when it cannot, nothing can.
  if (!lhsDecl) return ref.kind === "dot_access";

  // Read the declared type directly. `resolveTypeName` exists to find a type
  // worth resolving to a class and drops every PRIMITIVE_TYPES entry on the
  // floor — which is precisely the set this predicate is about.
  const type = lhsDecl.declaredType ?? lhsDecl.assignedType;
  return type !== undefined && MEMBERLESS_RECEIVER_TYPE.test(type.trim());
}

/**
 * True when the cursor sits on the member of a receiver that has none.
 *
 * The reference carries the receiver name; `receiverNamesNoMember` decides
 * from its declared type. Shared with the cross-file resolver so the two
 * cannot disagree about what a mapping is.
 */
export function memberOfMemberlessReceiver(
  table: SymbolTable,
  params: { position: { line: number; character: number } },
): boolean {
  const ref = table.references.find(
    r => r.loc.line === params.position.line &&
      params.position.character >= r.loc.character &&
      params.position.character < r.loc.character + r.name.length,
  );
  return ref !== undefined && receiverNamesNoMember(ref, table);
}
