/**
 * Recursively strip `scope(N, ...)` wrappers from Pike type signatures.
 *
 * Pike uses `scope(0, ...)` for local and `scope(1, ...)` for external scope.
 * These can nest: `scope(0, scope(1, function(...:...)))`.
 *
 * Uses balanced-paren tracking so it won't break on inner parens from
 * `function(...)`, `__attribute__(...)`, or overload unions.
 */

const SCOPE_PREFIX_RE = /^scope\(\d+,/;

/**
 * Strip all outer `scope(N, ...)` wrappers from a raw Pike type signature.
 * Returns the innermost unwrapped content.
 */
export function stripScopeWrapper(sig: string): string {
  let result = sig.trim();

  // Bounded: each iteration removes one outer scope(...) wrapper from result.
  while (true) {
    const match = result.match(SCOPE_PREFIX_RE);
    if (!match) break;

    const inner = result.slice(match[0].length);

    // Walk forward counting balanced parens to find the closing ')' of scope(...).
    // depth starts at 1 because scope( has already been consumed.
    let depth = 1;
    let end = -1;

    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }

    if (end === -1) break; // unbalanced — stop stripping

    result = inner.slice(0, end).trim();
  }

  return result;
}

/**
 * Replace `__attribute__("name", TYPE)` annotations with their bare TYPE.
 *
 * Attribute types in the predef data are simple (string, mixed), so a
 * paren-free inner match suffices; unmatched text is left as-is (fail-soft).
 *
 * Shared deliberately: hover had its own version that deleted
 * `__attribute__("...",` and left the closing paren behind, so every efun whose
 * type carries an attribute rendered an unbalanced signature — `sprintf` hovered
 * as `sprintf(object|string), mixed) ... : string)) → mixed`. Two copies of one
 * rule is how that drift happened.
 */
export function stripAttributes(text: string): string {
  let out = text;
  // Bounded: each pass removes one attribute; the data has at most a handful.
  for (let i = 0; i < 16; i++) {
    const next = out.replace(/__attribute__\("[^"]*",\s*([^()]*)\)/, "$1");
    if (next === out) break;
    out = next;
  }
  return out;
}
