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
