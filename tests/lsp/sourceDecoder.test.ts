/**
 * Source encoding detection.
 *
 * Pike source predating universal UTF-8 is commonly ISO-8859-1 — 241 of the
 * 442 Pike files in Roxen 6.1 are. Reading those as UTF-8 substitutes U+FFFD
 * for each non-ASCII byte, corrupting the text and every offset derived
 * from it.
 */

import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeSource, readSource } from "../../server/src/util/sourceDecoder";

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

  test("honours an explicit #charset directive over valid UTF-8, decoding actual iso-8859-2 characters", () => {
    // Content assertion, not just the label: a wrong entry among the 96
    // values in HIGH_HALF_TABLES would pass silently if only `encoding`
    // were checked. 0xE1 -> á (U+00E1), 0xB9 -> š (U+0161) in real
    // ISO-8859-2 — verified independently against Python codecs, iconv,
    // and Node's ICU TextDecoder.
    const buf = Buffer.from([
      ...Buffer.from("#charset iso-8859-2\nint label = "), 0xe1, 0xb9, ...Buffer.from(";\n"),
    ]);
    const { text, encoding } = decodeSource(buf);
    expect(encoding).toBe("iso-8859-2");
    expect(text).toContain("á");
    expect(text).toContain("š");
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

  test("surfaces a declared charset no runtime will ever support, instead of downgrading silently", () => {
    // Bun genuinely lacks "koi8-r", but Node's ICU-backed TextDecoder
    // supports it fine, and production runs Node (bin/pike-language-server
    // is `#!/usr/bin/env node`; the extension host launches server/dist/
    // server.mjs under Node too). Asserting against koi8-r would encode a
    // Bun-only quirk as expected behavior and fail on the runtime we ship.
    // An invented label is runtime-independent: nothing will ever support it.
    const buf = Buffer.from("#charset x-pike-no-such-charset\nint x;\n", "utf-8");
    const { text, encoding, declaredButUnsupported } = decodeSource(buf);
    expect(declaredButUnsupported).toBe("x-pike-no-such-charset");
    // Best-effort decode still happens — it just isn't silently mislabeled.
    expect(encoding).toBe("utf-8");
    expect(text).toContain("int x;");
  });

  test("ISO-8859-1 fallback is true byte-identity, not windows-1252", () => {
    // TextDecoder("iso-8859-1") is, per WHATWG, actually the windows-1252
    // decoder: it remaps 0x93 to U+201C (a curly quote). True ISO-8859-1 —
    // and real pike's raw undeclared-byte read — gives U+0093 (a C1
    // control code), and is length-preserving either way.
    const buf = Buffer.from([0x93, 0xff]); // both bytes are invalid UTF-8
    const { text, encoding } = decodeSource(buf);
    expect(encoding).toBe("iso-8859-1");
    expect(text.codePointAt(0)).toBe(0x93);
    expect(text.codePointAt(1)).toBe(0xff);
  });

  describe("comment- and string-aware #charset detection", () => {
    // Proven against real pike v8.0.1116: a #charset directive inside a
    // block comment, a #"raw string", or a // line comment is NOT honored.
    // The bytes 0xC3 0xA9 are valid UTF-8 for "é" (a single character) but
    // decode as two separate ISO-8859-2 characters "Ă" + "Š" if the
    // directive were (wrongly) honored — so the resulting text proves
    // which happened, not just the reported label.
    const NON_ASCII_BYTES = [0xc3, 0xa9];

    test("a #charset inside a /* block comment */ is not honored", () => {
      const buf = Buffer.from([
        ...Buffer.from("/*\n#charset iso-8859-2\n*/\nint x = "),
        ...NON_ASCII_BYTES,
        ...Buffer.from(";\n"),
      ]);
      const { text, encoding, declaredButUnsupported } = decodeSource(buf);
      expect(encoding).toBe("utf-8");
      expect(declaredButUnsupported).toBeUndefined();
      expect(text).toContain("é");
      expect(text).not.toContain("Š");
    });

    test('a #charset inside a #"raw string" is not honored', () => {
      const buf = Buffer.from([
        ...Buffer.from('constant d = #"\n#charset iso-8859-2\n";\nint x = '),
        ...NON_ASCII_BYTES,
        ...Buffer.from(";\n"),
      ]);
      const { text, encoding, declaredButUnsupported } = decodeSource(buf);
      expect(encoding).toBe("utf-8");
      expect(declaredButUnsupported).toBeUndefined();
      expect(text).toContain("é");
      expect(text).not.toContain("Š");
    });

    test("a #charset inside a // line comment is not honored", () => {
      const buf = Buffer.from([
        ...Buffer.from("// #charset iso-8859-2\nint x = "),
        ...NON_ASCII_BYTES,
        ...Buffer.from(";\n"),
      ]);
      const { text, encoding, declaredButUnsupported } = decodeSource(buf);
      expect(encoding).toBe("utf-8");
      expect(declaredButUnsupported).toBeUndefined();
      expect(text).toContain("é");
      expect(text).not.toContain("Š");
    });

    test("a #charset appearing after real code (not in a comment/string) IS honored", () => {
      // IMPORTANT: pike does not require the directive to precede all code —
      // only comments and strings must be skipped, not code in general.
      const buf = Buffer.from([
        ...Buffer.from("int dummy = 1;\n#charset iso-8859-2\nint x = "),
        ...NON_ASCII_BYTES,
        ...Buffer.from(";\n"),
      ]);
      const { text, encoding } = decodeSource(buf);
      expect(encoding).toBe("iso-8859-2");
      expect(text).toContain("Ă");
      expect(text).toContain("Š");
      expect(text).not.toContain("é");
    });

    // A char literal containing a `/*` or `#"` sequence must not be mistaken
    // for the start of a real block comment or raw string — both are
    // cross-line states, so an untracked one would swallow a real #charset
    // directive on a later line. Proven against real pike (v8.0.1116): both
    // `int c = '/*';` and `int c = '#"';` compile fine (confirming the char
    // literal itself parses correctly — c=12074 and c=8994 respectively,
    // the combined byte values of the two-character literal) AND still
    // honor a #charset directive on the following line.

    test("a #charset after a char literal containing '/*' IS still honored", () => {
      const buf = Buffer.from([
        ...Buffer.from("int c = '/*';\n#charset iso-8859-2\nint x = "),
        ...NON_ASCII_BYTES,
        ...Buffer.from(";\n"),
      ]);
      const { text, encoding } = decodeSource(buf);
      expect(encoding).toBe("iso-8859-2");
      expect(text).toContain("Ă");
      expect(text).toContain("Š");
      expect(text).not.toContain("é");
    });

    test('a #charset after a char literal containing \'#"\' IS still honored', () => {
      const buf = Buffer.from([
        ...Buffer.from('int c = \'#"\';\n#charset iso-8859-2\nint x = '),
        ...NON_ASCII_BYTES,
        ...Buffer.from(";\n"),
      ]);
      const { text, encoding } = decodeSource(buf);
      expect(encoding).toBe("iso-8859-2");
      expect(text).toContain("Ă");
      expect(text).toContain("Š");
      expect(text).not.toContain("é");
    });
  });
});

describe("readSource", () => {
  test("a throwing onUnsupportedCharset callback does not turn a good read into a rejection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pike-lsp-sourcedecoder-"));
    try {
      const file = join(dir, "bad-charset.pike");
      writeFileSync(file, "#charset x-pike-no-such-charset\nint x;\n");

      const text = await readSource(file, () => {
        throw new Error("logging blew up");
      });

      expect(text).toContain("int x;");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
