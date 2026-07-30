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
}

export function decodeSource(buf: Uint8Array): DecodedSource {
  const declared = findCharset(buf);
  if (declared) {
    try {
      return { text: new TextDecoder(declared).decode(buf), encoding: declared };
    } catch {
      const table = HIGH_HALF_TABLES[declared];
      if (table) {
        return { text: decodeHighHalfTable(buf, table), encoding: declared };
      }
      // Unknown or unsupported label with no built-in table — fall through to sniffing.
    }
  }

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

/** Read a Pike source file from disk, decoding by detected encoding. */
export async function readSource(path: string): Promise<string> {
  return decodeSource(await readFile(path)).text;
}
