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
import { pathToFileURL } from "node:url";
import { decodeSource, readSource } from "../../server/src/util/sourceDecoder";
import { initParser, parse } from "../../server/src/parser";
import { buildSymbolTable } from "../../server/src/features/symbolTable";

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

  test("strips a leading UTF-8 BOM before falling back to ISO-8859-1", () => {
    // TextDecoder("utf-8", {fatal:true}) strips a leading BOM; Buffer.toString
    // ("latin1") does not — an asymmetry that, left unfixed, decodes a BOM'd
    // ISO-8859-1 file as three phantom leading characters ("ï»¿"), shifting
    // every position on line 0. Real pike rejects a BOM outright (see
    // "readSource" tests below aren't the place for it — verified separately
    // via `pike`: `Illegal character '»'`), so this is about editor-facing
    // consistency, not pike parity.
    const buf = Buffer.from([
      0xef, 0xbb, 0xbf, ...Buffer.from("int x; // "), 0xa9, ...Buffer.from("\n"),
    ]);
    const { text, encoding } = decodeSource(buf);
    expect(encoding).toBe("iso-8859-1");
    expect(text.startsWith("int x;")).toBe(true);
    expect(text).not.toContain("ï»¿");
  });

  test("strips a leading UTF-8 BOM before decoding a declared #charset", () => {
    // Runtime-independent by design: decodeSource's declared-charset branch
    // takes ONE of two code paths for "iso-8859-2" depending on whether the
    // runtime's TextDecoder supports that label natively — Node's ICU-backed
    // TextDecoder does (this exercises `new TextDecoder("iso-8859-2")`
    // directly), Bun 1.3.14 doesn't (this exercises the HIGH_HALF_TABLES
    // fallback instead). Both must independently strip the BOM: WHATWG only
    // has TextDecoder strip a BOM for utf-8/utf-16, never for iso-8859-*, so
    // this is NOT the same guarantee as the utf-8 case, and asserting only
    // under whichever path Bun happens to hit would miss the other one — a
    // real regression here decoded a BOM'd iso-8859-2 file as "ďťż..." under
    // Node while Bun's table path (not exercising TextDecoder at all) stayed
    // clean, which is exactly the Bun-only-quirk trap the koi8-r test above
    // warns about. Checks for both possible phantom forms so this fails
    // regardless of which runtime executes it.
    //
    // The #charset directive sits on its own line (after a leading blank
    // line) rather than immediately after the BOM: CHARSET_RE is line-
    // anchored (`^`), and findCharset doesn't strip the BOM before matching
    // — three latin1-view BOM characters on the same line as `#charset`
    // would make `^` fail to match there. That's a pre-existing, separate
    // limitation from the one this test targets (the decode-path asymmetry
    // once a charset IS found), so this fixture sidesteps it rather than
    // conflating the two.
    const buf = Buffer.from([
      0xef, 0xbb, 0xbf,
      ...Buffer.from("\n#charset iso-8859-2\nint label = "), 0xb9, ...Buffer.from(";\n"),
    ]);
    const { text, encoding } = decodeSource(buf);
    expect(encoding).toBe("iso-8859-2");
    expect(text).toContain("#charset");
    expect(text).toContain("š");
    expect(text).not.toContain("ï»¿"); // phantom form via the latin1/table paths
    expect(text).not.toContain("ďťż"); // phantom form via TextDecoder("iso-8859-2")
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

  describe("backslash-newline splice (proven against real pike v8.0.1116)", () => {
    // Pike splices a backslash-newline pair away at the token-stream level
    // GLOBALLY (`int ma\` + newline + `in(){}` compiles as `int main(){}`),
    // but that does NOT mean every backslash-newline hides a `#charset` on
    // the next physical line — an EARLIER version of this comment claimed
    // that and was wrong; do not restate it. The actual rule, oracle-
    // verified case by case below:
    //   - An ORDINARY CODE line's trailing splice leaves the NEXT physical
    //     line fully eligible as its own directive (`int dummy = 1 \` +
    //     newline + `#charset ...` IS honoured — corroborated by
    //     `int dummy = 1 \` + newline + `#define BAR 42` successfully
    //     defining BAR, i.e. the #define is genuinely processed as its own
    //     directive rather than being swallowed).
    //   - A line that is ITSELF a directive (`#define ...\`) or a `//`
    //     comment swallows its OWN continuation as part of the same
    //     directive/comment instead — NOT honoured.
    //   - CRLF splices the same way as bare LF in both cases.
    // 0xb9 discriminates: raw/latin1 -> U+00B9 ("¹"), iso-8859-2 -> U+0161
    // ("š"). Each case below was run through real pike (v8.0.1116) via a
    // `string s = "<0xb9>"; write("%d\n", s[0]);` program (code-line splice
    // cases use a lone `;` on the line right after the directive, so the
    // spliced statement still closes and the program still compiles) to get
    // the honoured/not-honoured verdict, matching the assertions here.

    test("honours `# charset` with a space after the hash (pike: honoured, 353)", () => {
      const buf = Buffer.from([
        ...Buffer.from("# charset iso-8859-2\nstring s = \""), 0xb9, ...Buffer.from("\";\n"),
      ]);
      const { text, encoding } = decodeSource(buf);
      expect(encoding).toBe("iso-8859-2");
      expect(text).toContain("š");
    });

    test("does NOT honour a #charset spliced onto a // comment via backslash-newline (pike: not honoured, 185)", () => {
      const buf = Buffer.from([
        ...Buffer.from("// comment \\\n#charset iso-8859-2\nstring s = \""), 0xb9, ...Buffer.from("\";\n"),
      ]);
      const { text, encoding } = decodeSource(buf);
      expect(encoding).toBe("iso-8859-1");
      expect(text).toContain("¹");
      expect(text).not.toContain("š");
    });

    test("does NOT honour a #charset spliced onto a #define via backslash-newline (pike: not honoured, 185)", () => {
      const buf = Buffer.from([
        ...Buffer.from("#define FOO 1 \\\n#charset iso-8859-2\nstring s = \""), 0xb9, ...Buffer.from("\";\n"),
      ]);
      const { text, encoding } = decodeSource(buf);
      expect(encoding).toBe("iso-8859-1");
      expect(text).toContain("¹");
      expect(text).not.toContain("š");
    });

    test("HONOURS a #charset following an ORDINARY code line's splice (pike: honoured, 353)", () => {
      // The regression this test guards against: an earlier fix made this
      // splice unconditional (fired regardless of what kind of line it was
      // in), which caused this exact case to flip to NOT-honoured — the
      // opposite of what pike does. `int dummy = 1 \` is ordinary code, not
      // a directive, so its splice must leave `#charset` on the next
      // physical line fully eligible as its own directive.
      const buf = Buffer.from([
        ...Buffer.from("int dummy = 1 \\\n#charset iso-8859-2\nstring s = \""), 0xb9, ...Buffer.from("\";\n"),
      ]);
      const { text, encoding } = decodeSource(buf);
      expect(encoding).toBe("iso-8859-2");
      expect(text).toContain("š");
    });

    test("does NOT honour a #charset spliced onto a // comment via CRLF backslash-newline (pike: not honoured, 185)", () => {
      // Pre-existing gap (not introduced by the splice-model regression):
      // both splice branches only tested `next === "\n"`, so a CRLF line
      // ending was never recognized as a splice at all, and the comment
      // just ran out its normal per-character scan to the bare `\n` of the
      // SAME line — leaving `#charset` on the following line unblanked and
      // wrongly matchable.
      const buf = Buffer.from([
        ...Buffer.from("// comment \\\r\n#charset iso-8859-2\nstring s = \""), 0xb9, ...Buffer.from("\";\n"),
      ]);
      const { text, encoding } = decodeSource(buf);
      expect(encoding).toBe("iso-8859-1");
      expect(text).toContain("¹");
      expect(text).not.toContain("š");
    });

    test("HONOURS a #charset following an ordinary code line's CRLF splice (pike: honoured, 353)", () => {
      const buf = Buffer.from([
        ...Buffer.from("int dummy = 1 \\\r\n#charset iso-8859-2\nstring s = \""), 0xb9, ...Buffer.from("\";\n"),
      ]);
      const { text, encoding } = decodeSource(buf);
      expect(encoding).toBe("iso-8859-2");
      expect(text).toContain("š");
    });

    test("does NOT honour a #charset spliced onto a #define via CRLF backslash-newline (pike: not honoured, 185)", () => {
      const buf = Buffer.from([
        ...Buffer.from("#define FOO 1 \\\r\n#charset iso-8859-2\nstring s = \""), 0xb9, ...Buffer.from("\";\n"),
      ]);
      const { text, encoding } = decodeSource(buf);
      expect(encoding).toBe("iso-8859-1");
      expect(text).toContain("¹");
      expect(text).not.toContain("š");
    });

    test("HONOURS the exotic case: // comment, then a lone `\\` continuation line, then #charset (pike: honoured, 353)", () => {
      // A continuation line that is JUST a backslash ends the comment right
      // there (oracle-verified) — only explained by the comment's splice
      // handling consuming one MORE character past the spliced newline
      // before resuming: that extra character IS this line's own lone `\`,
      // which lands the scan on ITS terminating newline and ends the
      // comment, leaving #charset on the line after fully exposed.
      const buf = Buffer.from([
        ...Buffer.from("// comment \\\n\\\n#charset iso-8859-2\nstring s = \""), 0xb9, ...Buffer.from("\";\n"),
      ]);
      const { text, encoding } = decodeSource(buf);
      expect(encoding).toBe("iso-8859-2");
      expect(text).toContain("š");
    });

    test.each([
      "a\\",
      "ab\\",
      " \\",
    ])("does NOT honour the exotic case: // comment, then %j continuation, then #charset (pike: not honoured, 185)", (line2) => {
      // Contrast with the lone-backslash case above: any continuation line
      // with content BEFORE its own trailing backslash keeps the comment
      // going (oracle-verified for all three shapes here) — the "extra
      // character" consumed past the first splice is inert filler from
      // that content, leaving the line's OWN backslash to trigger a fresh
      // splice next, chaining the comment through to swallow #charset too.
      const buf = Buffer.from([
        ...Buffer.from(`// comment \\\n${line2}\n#charset iso-8859-2\nstring s = "`), 0xb9, ...Buffer.from(`";\n`),
      ]);
      const { text, encoding } = decodeSource(buf);
      expect(encoding).toBe("iso-8859-1");
      expect(text).toContain("¹");
      expect(text).not.toContain("š");
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

describe("decoded text drives positions (spec source-encoding S4)", () => {
  // Pins the behavior end to end: an on-disk ISO-8859-1 file, read through
  // readSource (which sniffs the encoding), parsed by tree-sitter, and fed
  // into buildSymbolTable — the declaration's nameRange must land at the
  // same column a naive `line.indexOf(name)` on the DECODED text would find,
  // proving positions are derived from the decoded string, not raw bytes.
  test("a declaration's nameRange.start.character matches line.indexOf(name) on ISO-8859-1 source", async () => {
    await initParser();

    const dir = mkdtempSync(join(tmpdir(), "pike-lsp-sourceencoding-"));
    try {
      const file = join(dir, "copyright-helper.pike");
      // "/* Copyright © 2009 */ int helper() { return 1; }" with © as the raw
      // ISO-8859-1 byte 0xA9 (an invalid lone UTF-8 continuation byte, so
      // readSource's sniff falls back to ISO-8859-1 rather than UTF-8).
      writeFileSync(file, Buffer.from([
        ...Buffer.from("/* Copyright "), 0xa9,
        ...Buffer.from(" 2009 */ int helper() { return 1; }\n"),
      ]));

      const text = await readSource(file);
      expect(text).toContain("©"); // confirms the ISO-8859-1 fallback ran

      const uri = pathToFileURL(file).href;
      const tree = parse(text, uri);
      expect(tree.rootNode.hasError).toBe(false);

      const table = buildSymbolTable(tree, uri, 1, undefined, text);
      const helper = table.declarations.find((d) => d.name === "helper");
      expect(helper).toBeDefined();

      const line0 = text.split("\n")[0]!;
      expect(helper!.nameRange.start.line).toBe(0);
      expect(helper!.nameRange.start.character).toBe(line0.indexOf("helper"));
      expect(line0.indexOf("helper")).toBe(27); // pinned per the design doc
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
