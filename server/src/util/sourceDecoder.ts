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
const CHARSET_RE = /^[ \t]*#charset[ \t]+([A-Za-z0-9_-]+)/m;

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
      return { text: new TextDecoder(resolved).decode(buf), encoding: resolved };
    } catch {
      const table = HIGH_HALF_TABLES[resolved];
      if (table) {
        return { text: decodeHighHalfTable(buf, table), encoding: resolved };
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
    return { text: Buffer.from(buf).toString("latin1"), encoding: "iso-8859-1" };
  }
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

type ScanState = "normal" | "line-comment" | "block-comment" | "string" | "raw-string";

/**
 * Blank out `// line comments`, `/* block comments *\/`, and `#"raw strings"`
 * before scanning for `#charset` — proven against real pike (v8.0.1116):
 * a directive inside any of those three regions is NOT honored, but our
 * previous plain regex honored all three, silently drifting every position
 * after such a comment/string by the byte-length delta between encodings.
 * A directive appearing after real code, outside those regions, IS honored
 * by pike and must stay matchable here — so this only strips comments and
 * strings, it does not require the directive to precede all code.
 *
 * Regular `"quoted strings"` are also tracked (a stray `/*`-looking sequence
 * inside one must not be mistaken for a real block comment) even though pike
 * itself cannot honor a directive there anyway — a regular string can't
 * span a line (an embedded literal newline is a compile error), so it can
 * never make `^[ \t]*#charset` match at a line start.
 *
 * Newlines are always preserved unblanked so the line-anchored regex still
 * sees correct line boundaries in the stripped text.
 */
function stripCommentsAndStrings(head: string): string {
  let out = "";
  let state: ScanState = "normal";

  for (let i = 0; i < head.length; i++) {
    const ch = head[i]!;
    const next = head[i + 1];

    if (state === "normal") {
      if (ch === "/" && next === "*") { state = "block-comment"; out += "  "; i++; }
      else if (ch === "/" && next === "/") { state = "line-comment"; out += "  "; i++; }
      else if (ch === "#" && next === '"') { state = "raw-string"; out += "  "; i++; }
      else if (ch === '"') { state = "string"; out += " "; }
      else out += ch;
    } else if (state === "line-comment") {
      if (ch === "\n") { state = "normal"; out += "\n"; }
      else out += " ";
    } else if (state === "block-comment") {
      if (ch === "*" && next === "/") { state = "normal"; out += "  "; i++; }
      else out += ch === "\n" ? "\n" : " ";
    } else if (state === "string") {
      // Regular strings can't span a line in real pike; bail out at a
      // literal newline rather than swallowing the rest of the buffer.
      if (ch === "\\" && next !== undefined) { out += "  "; i++; }
      else if (ch === '"' || ch === "\n") { state = "normal"; out += ch === "\n" ? "\n" : " "; }
      else out += " ";
    } else {
      // raw-string: spans lines freely, same backslash-escaping as a
      // regular string, terminates only at an unescaped quote.
      if (ch === "\\" && next !== undefined) { out += "  "; i++; }
      else if (ch === '"') { state = "normal"; out += " "; }
      else out += ch === "\n" ? "\n" : " ";
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
