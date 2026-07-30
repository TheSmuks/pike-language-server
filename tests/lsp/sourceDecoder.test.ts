/**
 * Source encoding detection.
 *
 * Pike source predating universal UTF-8 is commonly ISO-8859-1 — 241 of the
 * 442 Pike files in Roxen 6.1 are. Reading those as UTF-8 substitutes U+FFFD
 * for each non-ASCII byte, corrupting the text and every offset derived
 * from it.
 */

import { test, expect, describe } from "bun:test";
import { decodeSource } from "../../server/src/util/sourceDecoder";

describe("decodeSource", () => {
  test("decodes valid UTF-8 as UTF-8", () => {
    const buf = Buffer.from("// Copyright © 2009\nint x;\n", "utf-8");
    const { text, encoding } = decodeSource(buf);
    expect(encoding).toBe("utf-8");
    expect(text).toContain("©");
    expect(text).not.toContain("�");
  });

  test("decodes ISO-8859-1 bytes as ISO-8859-1", () => {
    // 0xA9 is © in ISO-8859-1 and an invalid lone continuation byte in UTF-8.
    const buf = Buffer.from([
      ...Buffer.from("// Copyright "), 0xa9, ...Buffer.from(" 2009\nint x;\n"),
    ]);
    const { text, encoding } = decodeSource(buf);
    expect(encoding).toBe("iso-8859-1");
    expect(text).toContain("©");
    expect(text).not.toContain("�");
  });

  test("honours an explicit #charset directive over valid UTF-8", () => {
    const buf = Buffer.from("#charset iso-8859-2\nint x;\n", "utf-8");
    const { encoding } = decodeSource(buf);
    expect(encoding).toBe("iso-8859-2");
  });

  test("honours #charset utf-8", () => {
    const buf = Buffer.from("#charset utf-8\nint x;\n", "utf-8");
    expect(decodeSource(buf).encoding).toBe("utf-8");
  });

  test("pure ASCII decodes as UTF-8 unchanged", () => {
    const buf = Buffer.from("int main() { return 0; }\n", "utf-8");
    const { text, encoding } = decodeSource(buf);
    expect(encoding).toBe("utf-8");
    expect(text).toBe("int main() { return 0; }\n");
  });

  test("aliases #charset iso-2022 to iso-2022-jp and decodes real JIS escapes", () => {
    // Real bytes from the Roxen corpus's server/languages/japanese.pike shape:
    // `#charset iso-2022` followed by JIS X 0208-1983 escape sequences
    // (ESC $ B ... ESC ( B) encoding "日本語". Generated via Python's
    // iso2022_jp codec, not hand-transcribed, to avoid a wrong escape byte.
    const buf = Buffer.from([
      35, 99, 104, 97, 114, 115, 101, 116, 32, 105, 115, 111, 45, 50, 48, 50,
      50, 10, 99, 111, 110, 115, 116, 97, 110, 116, 32, 95, 105, 100, 32, 61,
      32, 40, 123, 32, 34, 106, 97, 34, 44, 32, 34, 106, 97, 112, 97, 110,
      101, 115, 101, 34, 44, 32, 34, 27, 36, 66, 70, 124, 75, 92, 56, 108,
      27, 40, 66, 34, 32, 125, 41, 59, 10,
    ]);
    const { text, encoding, declaredButUnsupported } = decodeSource(buf);
    expect(encoding).toBe("iso-2022-jp");
    expect(declaredButUnsupported).toBeUndefined();
    expect(text).toContain("日本語");
  });

  test("surfaces a declared charset the runtime cannot honor instead of downgrading silently", () => {
    // koi8-r is a real WHATWG label with no built-in table here, and this
    // runtime's TextDecoder does not implement it (verified: Bun 1.3.14
    // throws ERR_ENCODING_NOT_SUPPORTED for "koi8-r").
    const buf = Buffer.from("#charset koi8-r\nint x;\n", "utf-8");
    const { text, encoding, declaredButUnsupported } = decodeSource(buf);
    expect(declaredButUnsupported).toBe("koi8-r");
    // Best-effort decode still happens — it just isn't silently mislabeled.
    expect(encoding).toBe("utf-8");
    expect(text).toContain("int x;");
  });
});
