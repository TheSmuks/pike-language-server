/**
 * Pike source decoding.
 *
 * Detection order: an explicit `#charset` directive, else UTF-8 when the bytes
 * are valid UTF-8, else ISO-8859-1 (true byte-identity ISO-8859-1 via
 * `Buffer.toString("latin1")` — NOT `TextDecoder("iso-8859-1")`, which per
 * WHATWG is actually the windows-1252 decoder and remaps bytes 0x80-0x9F to
 * curly quotes and friends instead of leaving them as C1 controls; verified
 * against real pike, which reads undeclared high bytes as raw byte-identity
 * values). The ISO-8859-1 fallback cannot fail — every byte sequence is
 * valid — so detection always yields text.
 *
 * Applies to Pike source only. Server-owned JSON stays UTF-8.
 */
import { readFile } from "node:fs/promises";

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** Matches `#charset <name>` in the leading region of a file. */
const CHARSET_RE = /^[ \t]*#[ \t]*charset[ \t]+([A-Za-z0-9_-]+)/m;

/**
 * Evidence-backed label aliases. Real files in the Roxen 6.1 corpus declare
 * `#charset iso-2022`, which the WHATWG registry does not recognize as a
 * label on its own — but `server/languages/japanese.pike` (declared charset
 * + `constant required_charset = "iso-2022"`) contains 128 JIS X 0208-1983
 * escape sequences (`ESC $ B`), i.e. it means ISO-2022-JP in practice. Bun's
 * TextDecoder supports "iso-2022-jp" but not the bare "iso-2022" label.
 *
 * Only add entries here backed by a real file in evidence — this is not a
 * place to pre-emptively guess at label equivalences.
 */
const CHARSET_ALIASES: Record<string, string> = {
  "iso-2022": "iso-2022-jp",
};

/**
 * Built-in decode tables for labels a runtime's TextDecoder might not
 * implement. Node's ICU-backed TextDecoder supports "iso-8859-2" natively;
 * Bun 1.3.14 does not (`ERR_ENCODING_NOT_SUPPORTED`). The table keeps
 * decoding identical on both runtimes we ship on — production is Node
 * (`bin/pike-language-server` is `#!/usr/bin/env node`), but the test suite
 * runs under Bun, and the Roxen 6.1 corpus has a real `#charset iso-8859-2`
 * file, so this isn't a workaround for a runtime we don't ship, it's parity
 * insurance. Each table covers only bytes 0xA0-0xFF; below that, ISO-8859-*
 * code points equal the byte value (ASCII + C1 controls).
 */
const HIGH_HALF_TABLES: Record<string, readonly number[]> = {
  "iso-8859-2": [
    160, 260, 728, 321, 164, 317, 346, 167, 168, 352, 350, 356, 377, 173, 381, 379,
    176, 261, 731, 322, 180, 318, 347, 711, 184, 353, 351, 357, 378, 733, 382, 380,
    340, 193, 194, 258, 196, 313, 262, 199, 268, 201, 280, 203, 282, 205, 206, 270,
    272, 323, 327, 211, 212, 336, 214, 215, 344, 366, 218, 368, 220, 221, 354, 223,
    341, 225, 226, 259, 228, 314, 263, 231, 269, 233, 281, 235, 283, 237, 238, 271,
    273, 324, 328, 243, 244, 337, 246, 247, 345, 367, 250, 369, 252, 253, 355, 729,
  ],
};

export interface DecodedSource {
  text: string;
  encoding: string;
  /**
   * Set when a `#charset` directive named an encoding that neither the
   * runtime's TextDecoder nor a built-in table could honor, so `text` was
   * produced by sniffing instead of the declared label. A silent downgrade
   * here is worse than a visible one: every position derived from `text`
   * may be wrong with no signal. Callers with a connection should log this.
   */
  declaredButUnsupported?: string;
}

export function decodeSource(buf: Uint8Array): DecodedSource {
  const declared = findCharset(buf);
  if (declared) {
    const resolved = CHARSET_ALIASES[declared] ?? declared;
    try {
      // stripBom applies here too: WHATWG only has TextDecoder strip a BOM
      // for utf-8/utf-16 — never for iso-8859-*, koi8-r, etc. — so a
      // declared-charset file (e.g. `#charset iso-8859-2`) with a leading
      // BOM would otherwise decode with the same three phantom leading
      // characters the latin1/high-half paths were fixed to avoid. This is
      // the branch production (Node) actually takes for any charset Node's
      // ICU TextDecoder natively supports — Bun 1.3.14 lacks iso-8859-2 and
      // falls to the table branch below instead, which is why this gap
      // didn't show up under the Bun-run test suite.
      return { text: new TextDecoder(resolved).decode(stripBom(buf)), encoding: resolved };
    } catch {
      const table = HIGH_HALF_TABLES[resolved];
      if (table) {
        return { text: decodeHighHalfTable(stripBom(buf), table), encoding: resolved };
      }
    }
    // Declared but neither the runtime nor a built-in table could honor it.
    // Report the sniffed result, but surface the downgrade rather than
    // silently claiming the sniffed encoding was what the file declared.
    return { ...sniff(buf), declaredButUnsupported: declared };
  }

  return sniff(buf);
}

/**
 * UTF-8 if valid, else true byte-identity ISO-8859-1 (which cannot fail).
 *
 * Real pike does NOT do this: absent a `#charset` directive, pike reads
 * undeclared source as raw byte-identity, full stop — verified directly
 * against pike v8.0.1116 (a file with valid multi-byte UTF-8 and no
 * directive decodes as separate raw bytes, not the merged character UTF-8
 * would produce; a leading UTF-8 BOM doesn't change this either — pike
 * chokes on its bytes as illegal characters rather than treating them as
 * an encoding signal).
 *
 * We sniff anyway, deliberately: LSP positions must match how the EDITOR
 * holds the document, not how the compiler reads it. Worked through for
 * `©`:
 *   - UTF-8 file (`©` = C2 A9): we sniff UTF-8 → 1 char. VS Code's default
 *     `files.encoding: utf8` → 1 char. Aligned.
 *   - ISO-8859-1 file (`©` = A9): we fall back to latin1 → 1 char. VS Code
 *     decoding as UTF-8 → 1 replacement char. Still 1 char — aligned.
 *   - pike itself sees raw bytes in both cases: 2 chars and 1 char. It
 *     differs from both us and the editor either way.
 *
 * Do NOT change this to match pike's raw-byte default. It would desync
 * every position this server emits from what the user actually sees and
 * clicks on. Pike's byte-oriented view only matters for mapping the pike
 * compiler's own diagnostic line/column back to LSP positions — a separate,
 * pre-existing concern this function does not touch.
 */
function sniff(buf: Uint8Array): DecodedSource {
  try {
    return { text: strictUtf8.decode(buf), encoding: "utf-8" };
  } catch {
    return { text: Buffer.from(stripBom(buf)).toString("latin1"), encoding: "iso-8859-1" };
  }
}

/**
 * Strip a leading UTF-8 BOM (`EF BB BF`), if present.
 *
 * `TextDecoder("utf-8", { fatal: true })` strips a leading BOM as part of
 * decoding — but per WHATWG, `TextDecoder` only does that for utf-8/utf-16;
 * a `TextDecoder("iso-8859-2")` (or any other label) does NOT strip it, any
 * more than `Buffer.toString("latin1")` or the high-half-table decoder do.
 * So this must be applied on every non-utf-8-via-TextDecoder path — the
 * `sniff()` latin1 fallback, the high-half-table branch, AND the declared-
 * charset `new TextDecoder(resolved)` branch in decodeSource — or a BOM'd
 * file decodes with three phantom leading characters ("ï»¿" for the latin1/
 * table paths; e.g. "ďťż" for iso-8859-2 via TextDecoder), shifting every
 * position on line 0 and producing a spurious tree-sitter ERROR the editor
 * never shows (VS Code strips BOMs before handing text to extensions).
 * Real pike does not treat a BOM as an encoding signal at all — it rejects
 * the bytes outright as illegal characters — so a BOM'd file never
 * compiles; that caps how much this matters, but doesn't make the phantom
 * characters correct.
 */
function stripBom(buf: Uint8Array): Uint8Array {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3);
  }
  return buf;
}

/**
 * Read the `#charset` label, if any. Scans only the first 4KB (as raw
 * byte-identity text, cheap and avoids decoding the file twice) — real pike
 * does honor a directive appearing after code, so this is not a "must
 * precede code" restriction, just a bound on how far we look.
 */
function findCharset(buf: Uint8Array): string | null {
  const head = Buffer.from(buf.subarray(0, 4096)).toString("latin1");
  const stripped = stripCommentsAndStrings(head);
  const m = CHARSET_RE.exec(stripped);
  return m ? m[1]!.toLowerCase() : null;
}

type ScanState =
  | "normal"
  | "line-comment"
  | "block-comment"
  | "string"
  | "raw-string"
  | "char-literal";

/** One scan step: text to emit, the resulting state, and how many extra lookahead chars (beyond `ch`) were consumed. */
interface ScanStep {
  emit: string;
  next: ScanState;
  skip: number;
}

/**
 * Width (in characters after `ch`) of a backslash-newline splice starting at
 * `ch`, or 0 if this isn't one. Handles both bare `\n` (width 1) and `\r\n`
 * (width 2) — pike splices either line-ending form.
 */
function spliceWidth(ch: string, next: string | undefined, next2: string | undefined): number {
  if (ch !== "\\") return 0;
  if (next === "\n") return 1;
  if (next === "\r" && next2 === "\n") return 2;
  return 0;
}

/**
 * Pike splices a backslash-newline pair away GLOBALLY at the token-stream
 * level (`int ma\` + newline + `in(){}` compiles as `int main(){}`) — but
 * that is NOT the same as every backslash-newline hiding a `#charset` on
 * the next physical line. Oracle-verified (pike v8.0.1116, both proven
 * false and true against real output — do not restate the false version):
 *
 *   - An ORDINARY CODE line's trailing splice joins the token stream but
 *     leaves the NEXT physical line fully eligible as its own directive:
 *     `int dummy = 1 \` + newline + `#charset iso-8859-2` IS honoured
 *     (the `#charset` is recognized and processed as a directive in its
 *     own right — corroborated by `int dummy = 1 \` + newline +
 *     `#define BAR 42` successfully defining BAR).
 *   - A line that is ITSELF a directive swallows its OWN continuation as
 *     part of the same directive, instead: `#define FOO 1 \` + newline +
 *     `#charset iso-8859-2` is NOT honoured — the `#charset ...` text
 *     becomes part of #define's replacement text, not a fresh directive
 *     (chains the same way across repeated splices).
 *
 * So the splice is only special-cased here (blanked, so `^` can't match on
 * the continuation) when `inDirective` — the current logical line's first
 * non-blank character was `#` — is true. Otherwise the backslash and its
 * newline pass through unblanked, so a real `^` boundary still exists for
 * CHARSET_RE to match against on the following line.
 */
function scanNormal(ch: string, next: string | undefined, next2: string | undefined, inDirective: boolean): ScanStep {
  const width = spliceWidth(ch, next, next2);
  if (width > 0 && inDirective) {
    return { emit: " ".repeat(1 + width), next: "normal", skip: width };
  }
  if (width > 0) {
    // Not a directive: let the backslash and its real newline through as-is.
    return { emit: ch, next: "normal", skip: 0 };
  }
  if (ch === "/" && next === "*") return { emit: "  ", next: "block-comment", skip: 1 };
  if (ch === "/" && next === "/") return { emit: "  ", next: "line-comment", skip: 1 };
  if (ch === "#" && next === '"') return { emit: "  ", next: "raw-string", skip: 1 };
  if (ch === '"') return { emit: " ", next: "string", skip: 0 };
  if (ch === "'") return { emit: " ", next: "char-literal", skip: 0 };
  return { emit: ch, next: "normal", skip: 0 };
}

/**
 * A `//` comment ALWAYS swallows a trailing backslash-newline splice
 * (unconditionally, unlike an ordinary code line) — but it consumes ONE
 * MORE character past the spliced newline before resuming normal comment
 * scanning. That extra character is exactly what pike does: on the line
 * following a spliced `// ... \`, a continuation consisting of just a lone
 * `\` ends the comment right there, whereas `a\`, `ab\`, and ` \` all keep
 * it going (oracle-verified, all four). Only "eat one more character,
 * unconditionally" explains this: for a single-char `\` line, that eaten
 * character IS the line's own backslash, landing the scan on ITS terminating
 * newline and ending the comment; for `a\`/`ab\`/` \`, the eaten character
 * is inert filler, leaving that line's own trailing backslash to trigger a
 * FRESH splice on the next iteration, chaining the comment onward. This is
 * also what makes `// c \` + newline + `\` + newline + `#charset ...`
 * (which pike DOES honour) come out right.
 */
function scanLineComment(ch: string, next: string | undefined, next2: string | undefined): ScanStep {
  const width = spliceWidth(ch, next, next2);
  if (width > 0) {
    return { emit: " ".repeat(1 + width + 1), next: "line-comment", skip: width + 1 };
  }
  return ch === "\n"
    ? { emit: "\n", next: "normal", skip: 0 }
    : { emit: " ", next: "line-comment", skip: 0 };
}

function scanBlockComment(ch: string, next: string | undefined): ScanStep {
  if (ch === "*" && next === "/") return { emit: "  ", next: "normal", skip: 1 };
  return { emit: ch === "\n" ? "\n" : " ", next: "block-comment", skip: 0 };
}

/**
 * Shared by regular `"strings"` and `'char literals'`: a backslash escapes
 * whatever follows it, and a single unescaped `quote` terminates. Neither
 * construct legitimately spans a literal newline in real pike (both are
 * compile errors there), so a literal newline bails back to `normal`
 * defensively rather than swallowing the rest of the buffer — pike refuses
 * to compile such a file anyway, so exact behavior past that point is not
 * observable.
 */
function scanSingleLineQuote(ch: string, next: string | undefined, quote: string, state: ScanState): ScanStep {
  if (ch === "\\" && next !== undefined) return { emit: "  ", next: state, skip: 1 };
  if (ch === quote || ch === "\n") return { emit: ch === "\n" ? "\n" : " ", next: "normal", skip: 0 };
  return { emit: " ", next: state, skip: 0 };
}

/** `#"raw strings"`: same escaping as `scanSingleLineQuote`, but spans lines freely. */
function scanRawString(ch: string, next: string | undefined): ScanStep {
  if (ch === "\\" && next !== undefined) return { emit: "  ", next: "raw-string", skip: 1 };
  if (ch === '"') return { emit: " ", next: "normal", skip: 0 };
  return { emit: ch === "\n" ? "\n" : " ", next: "raw-string", skip: 0 };
}

/**
 * Blank out `// line comments`, `/* block comments *\/`, `#"raw strings"`,
 * `"regular strings"`, and `'char literals'` before scanning for `#charset`
 * — proven against real pike (v8.0.1116): a directive inside any of those
 * is NOT honored, but a plain regex honors all of them, silently drifting
 * every position after such a region by the byte-length delta between
 * encodings. A directive appearing after real code, outside all of those
 * regions, IS honored by pike and must stay matchable here — so this only
 * strips comments/strings/char-literals, it does not require the directive
 * to precede all code.
 *
 * Char literals matter here even though they can't themselves contain
 * `#charset` (too short): an untracked `'/*'` or `'#"'` would be misread as
 * opening a real block comment or raw string, which — being a cross-line
 * state — can swallow a real `#charset` directive on a later line. Regular
 * strings are tracked for the same reason (a stray `/*`-looking sequence
 * inside one must not be mistaken for a real block comment), even though a
 * regular string can never itself make `^[ \t]*#charset` match (it can't
 * span a line).
 *
 * A real (unspliced) newline is always preserved so the line-anchored regex
 * still sees correct line boundaries in the stripped text. The only
 * deliberate exception is a backslash-newline splice that pike itself
 * removes from the token stream — inside a directive line or a `//`
 * comment, per scanNormal/scanLineComment above — which is blanked instead,
 * specifically so `^` can no longer match at that position.
 *
 * Also tracks, per physical line, whether the line is itself a preprocessor
 * directive (its first non-blank character is `#`) — `directiveLine` below
 * — since scanNormal's splice handling depends on it. It resets on every
 * real newline (never on a spliced one, which is exactly the distinction
 * that makes an ordinary code line's splice leave the next physical line
 * free while a directive's own splice does not).
 */
function stripCommentsAndStrings(head: string): string {
  let out = "";
  let state: ScanState = "normal";
  let sawNonBlank = false;
  let directiveLine = false;

  for (let i = 0; i < head.length; i++) {
    const ch = head[i]!;
    const next = head[i + 1];
    const next2 = head[i + 2];

    if (state === "normal" && !sawNonBlank && ch !== " " && ch !== "\t") {
      sawNonBlank = true;
      directiveLine = ch === "#";
    }

    const step: ScanStep =
      state === "normal" ? scanNormal(ch, next, next2, directiveLine)
      : state === "line-comment" ? scanLineComment(ch, next, next2)
      : state === "block-comment" ? scanBlockComment(ch, next)
      : state === "string" ? scanSingleLineQuote(ch, next, '"', "string")
      : state === "char-literal" ? scanSingleLineQuote(ch, next, "'", "char-literal")
      : scanRawString(ch, next);

    out += step.emit;
    state = step.next;
    if (step.skip > 0) i += step.skip;

    if (ch === "\n") {
      sawNonBlank = false;
      directiveLine = false;
    }
  }

  return out;
}

/** Decode using a built-in high-half table (see `HIGH_HALF_TABLES`). */
function decodeHighHalfTable(buf: Uint8Array, table: readonly number[]): string {
  let out = "";
  for (const byte of buf) {
    out += String.fromCodePoint(byte < 0xa0 ? byte : table[byte - 0xa0]!);
  }
  return out;
}

/**
 * Read a Pike source file from disk, decoding by detected encoding.
 *
 * `onUnsupportedCharset`, when given, is called when the file declared a
 * `#charset` that could not be honored — see `DecodedSource.declaredButUnsupported`.
 * Callers with a connection should use it to log a warning; this keeps the
 * common one-argument call sites (and the return type) unchanged. The
 * callback runs best-effort: a throw from it must never turn a successful
 * read into a rejected promise, so it is never allowed to propagate.
 */
export async function readSource(
  path: string,
  onUnsupportedCharset?: (declared: string, path: string) => void,
): Promise<string> {
  const decoded = decodeSource(await readFile(path));
  if (decoded.declaredButUnsupported && onUnsupportedCharset) {
    try {
      onUnsupportedCharset(decoded.declaredButUnsupported, path);
    } catch {
      // Logging is best-effort — never let it fail an otherwise-good read.
    }
  }
  return decoded.text;
}
