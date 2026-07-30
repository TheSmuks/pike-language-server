/**
 * Pike source decoding.
 *
 * Detection order: an explicit `#charset` directive, else UTF-8 when the bytes
 * are valid UTF-8, else ISO-8859-1. The fallback cannot fail — every byte
 * sequence is valid ISO-8859-1 — so detection always yields text.
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
 * Built-in decode tables for WHATWG labels this runtime's TextDecoder does
 * not implement. Observed on Bun 1.3.14: `new TextDecoder("iso-8859-2")`
 * throws `ERR_ENCODING_NOT_SUPPORTED`, even though Node's ICU-backed
 * TextDecoder handles it fine — and the Roxen 6.1 corpus has a real
 * `#charset iso-8859-2` file. Each table covers only bytes 0xA0-0xFF; below
 * that, ISO-8859-* code points equal the byte value (ASCII + C1 controls).
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

/** UTF-8 if valid, else ISO-8859-1 (which cannot fail). */
function sniff(buf: Uint8Array): DecodedSource {
  try {
    return { text: strictUtf8.decode(buf), encoding: "utf-8" };
  } catch {
    return {
      text: new TextDecoder("iso-8859-1").decode(buf),
      encoding: "iso-8859-1",
    };
  }
}

/**
 * Read the `#charset` label, if any. Scans only the first 4KB as ASCII: the
 * directive must precede code, and this avoids decoding the file twice.
 */
function findCharset(buf: Uint8Array): string | null {
  const head = new TextDecoder("iso-8859-1").decode(buf.subarray(0, 4096));
  const m = CHARSET_RE.exec(head);
  return m ? m[1]!.toLowerCase() : null;
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
 * common one-argument call sites (and the return type) unchanged.
 */
export async function readSource(
  path: string,
  onUnsupportedCharset?: (declared: string, path: string) => void,
): Promise<string> {
  const decoded = decodeSource(await readFile(path));
  if (decoded.declaredButUnsupported && onUnsupportedCharset) {
    onUnsupportedCharset(decoded.declaredButUnsupported, path);
  }
  return decoded.text;
}
