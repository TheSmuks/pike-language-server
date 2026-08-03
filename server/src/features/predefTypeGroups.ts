/**
 * Reading call shapes out of a raw predef type descriptor.
 *
 * Split out of signatureHelp-resolve.ts to keep both files under the 500-line
 * limit.
 */

/**
 * Every positive `function(...)` group in a raw predef type descriptor.
 *
 * Simple efuns are written `function(A : R) | function(B : R)`, which splitting
 * on " | function" handled. Overloaded ones like min/max are written as soft
 * alternatives — `function(void : zero) | !function(!string ... : mixed) &
 * function(string, string ... : string) | ...` — where every alternative after
 * the first begins " | !function", so the split never fired: the entire type
 * became a single "signature" whose label was raw type-descriptor text and
 * whose parameter list was empty.
 *
 * The `!function(...)` halves are negative constraints on the argument types,
 * not call shapes. Only the positive groups say how the efun may be called.
 */
export function positiveFunctionGroups(raw: string): string[] {
  const groups: string[] = [];
  const KEYWORD = "function";
  let i = 0;
  // Bounded: every iteration advances i by at least one.
  while (i < raw.length) {
    if (!raw.startsWith(KEYWORD, i)) { i++; continue; }
    // `!function(...)` is a constraint, not a call shape.
    if (i > 0 && raw[i - 1] === "!") { i += KEYWORD.length; continue; }

    let open = i + KEYWORD.length;
    while (open < raw.length && /\s/.test(raw[open])) open++;
    if (raw[open] !== "(") { i += KEYWORD.length; continue; }

    let depth = 0;
    let end = open;
    for (; end < raw.length; end++) {
      if (raw[end] === "(") depth++;
      else if (raw[end] === ")") {
        depth--;
        if (depth === 0) { end++; break; }
      }
    }
    if (depth !== 0) break;            // unbalanced — give up rather than guess
    groups.push(raw.slice(open, end));  // parens included
    i = end;                            // skip nested groups inside this one
  }
  return groups;
}

