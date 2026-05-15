/**
 * Position converter tests — UTF-8 ↔ UTF-16 conversion correctness.
 *
 * Goal: Verify that utf8ToUtf16 and utf16ToUtf8 produce correct mappings
 * for ASCII, 2/3/4-byte UTF-8 characters, mixed content, and edge cases,
 * and that roundtrips are identity-preserving.
 *
 * Methodology: For each character class we encode a known string, compute
 * expected offsets by hand, and assert the converters agree.
 */

import { test, expect, describe } from "bun:test";
import {
  utf8ToUtf16,
  utf16ToUtf8,
  getLineText,
} from "../../server/src/util/positionConverter";

// ---------------------------------------------------------------------------
// utf8ToUtf16 — pure ASCII (identity: byte offset === code unit offset)
// ---------------------------------------------------------------------------
describe("utf8ToUtf16 — pure ASCII", () => {
  test("offset 0 returns 0", () => {
    expect(utf8ToUtf16("hello", 0)).toBe(0);
  });

  test("offset at end returns string length", () => {
    expect(utf8ToUtf16("hello", 5)).toBe(5);
  });

  test("offset in middle returns same value", () => {
    expect(utf8ToUtf16("hello", 3)).toBe(3);
  });

  test("offset beyond end clamps to string length", () => {
    expect(utf8ToUtf16("hello", 100)).toBe(5);
  });

  test("negative offset clamps to 0", () => {
    expect(utf8ToUtf16("hello", -1)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// utf8ToUtf16 — 2-byte UTF-8 characters (e.g. é = U+00E9, ñ = U+00F1)
//   UTF-8: 2 bytes each. UTF-16: 1 code unit each.
// ---------------------------------------------------------------------------
describe("utf8ToUtf16 — 2-byte UTF-8 (é, ñ)", () => {
  // "café" = c(1) a(1) f(1) é(2) = 5 UTF-8 bytes, 4 UTF-16 code units
  const line = "café";

  test("byte offset 3 (start of é) → UTF-16 offset 3", () => {
    expect(utf8ToUtf16(line, 3)).toBe(3);
  });

  test("byte offset 5 (end of line) → UTF-16 offset 4", () => {
    expect(utf8ToUtf16(line, 5)).toBe(4);
  });

  test("byte offset 1 (between c and a) → UTF-16 offset 1", () => {
    expect(utf8ToUtf16(line, 1)).toBe(1);
  });

  test("byte offset 4 (mid-é, inside character) → clamp to char start 3", () => {
    // Byte 4 is the second byte of é — cannot split, returns char start.
    expect(utf8ToUtf16(line, 4)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// utf8ToUtf16 — 3-byte UTF-8 characters (e.g. 中 U+4E2D, 文 U+6587)
//   UTF-8: 3 bytes each. UTF-16: 1 code unit each.
// ---------------------------------------------------------------------------
describe("utf8ToUtf16 — 3-byte UTF-8 (中文)", () => {
  // "中文" = 中(3) 文(3) = 6 UTF-8 bytes, 2 UTF-16 code units
  const line = "中文";

  test("byte offset 0 → UTF-16 offset 0", () => {
    expect(utf8ToUtf16(line, 0)).toBe(0);
  });

  test("byte offset 3 (start of 文) → UTF-16 offset 1", () => {
    expect(utf8ToUtf16(line, 3)).toBe(1);
  });

  test("byte offset 6 (end) → UTF-16 offset 2", () => {
    expect(utf8ToUtf16(line, 6)).toBe(2);
  });

  test("byte offset 1 (inside 中) → clamp to 0", () => {
    expect(utf8ToUtf16(line, 1)).toBe(0);
  });

  test("byte offset 2 (inside 中) → clamp to 0", () => {
    expect(utf8ToUtf16(line, 2)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// utf8ToUtf16 — 4-byte UTF-8 / surrogate pairs (emoji)
//   UTF-8: 4 bytes each. UTF-16: 2 code units (surrogate pair) each.
// ---------------------------------------------------------------------------
describe("utf8ToUtf16 — 4-byte UTF-8 / surrogate pairs (emoji)", () => {
  // "a🎉b" = a(1) 🎉(4) b(1) = 6 UTF-8 bytes, 4 UTF-16 code units
  // 🎉 = U+1F389, surrogates: 0xD83C 0xDF89
  const line = "a🎉b";

  test("byte offset 0 → UTF-16 offset 0", () => {
    expect(utf8ToUtf16(line, 0)).toBe(0);
  });

  test("byte offset 1 (start of 🎉) → UTF-16 offset 1", () => {
    expect(utf8ToUtf16(line, 1)).toBe(1);
  });

  test("byte offset 5 (start of b) → UTF-16 offset 3", () => {
    expect(utf8ToUtf16(line, 5)).toBe(3);
  });

  test("byte offset 6 (end) → UTF-16 offset 4", () => {
    expect(utf8ToUtf16(line, 6)).toBe(4);
  });

  test("byte offset 3 (inside 🎉) → clamp to char start 1", () => {
    expect(utf8ToUtf16(line, 3)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// utf8ToUtf16 — mixed ASCII + CJK
// ---------------------------------------------------------------------------
describe("utf8ToUtf16 — mixed ASCII + CJK", () => {
  // "Hello, 世界!" = H(1) e(1) l(1) l(1) o(1) ,(1) (space)(1) 世(3) 界(3) !(1)
  // UTF-8: 14 bytes. UTF-16: 10 code units.
  const line = "Hello, 世界!";

  test("byte offset 7 (start of 世) → UTF-16 offset 7", () => {
    expect(utf8ToUtf16(line, 7)).toBe(7);
  });

  test("byte offset 10 (start of 界) → UTF-16 offset 8", () => {
    expect(utf8ToUtf16(line, 10)).toBe(8);
  });

  test("byte offset 13 (start of !) → UTF-16 offset 9", () => {
    expect(utf8ToUtf16(line, 13)).toBe(9);
  });

  test("byte offset 14 (end) → UTF-16 offset 10", () => {
    expect(utf8ToUtf16(line, 14)).toBe(10);
  });

  test("byte offset 8 (inside 世) → clamp to 7", () => {
    expect(utf8ToUtf16(line, 8)).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// utf16ToUtf8 — pure ASCII (identity)
// ---------------------------------------------------------------------------
describe("utf16ToUtf8 — pure ASCII", () => {
  test("offset 0 returns 0", () => {
    expect(utf16ToUtf8("hello", 0)).toBe(0);
  });

  test("offset at end returns byte length", () => {
    expect(utf16ToUtf8("hello", 5)).toBe(5);
  });

  test("offset in middle returns same value", () => {
    expect(utf16ToUtf8("hello", 3)).toBe(3);
  });

  test("offset beyond end clamps to byte length", () => {
    expect(utf16ToUtf8("hello", 100)).toBe(5);
  });

  test("negative offset clamps to 0", () => {
    expect(utf16ToUtf8("hello", -1)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// utf16ToUtf8 — 2-byte UTF-8 characters
// ---------------------------------------------------------------------------
describe("utf16ToUtf8 — 2-byte UTF-8 (é, ñ)", () => {
  // "café" = 5 UTF-8 bytes, 4 UTF-16 code units
  const line = "café";

  test("UTF-16 offset 3 (start of é) → byte offset 3", () => {
    expect(utf16ToUtf8(line, 3)).toBe(3);
  });

  test("UTF-16 offset 4 (end) → byte offset 5", () => {
    expect(utf16ToUtf8(line, 4)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// utf16ToUtf8 — 3-byte UTF-8 characters
// ---------------------------------------------------------------------------
describe("utf16ToUtf8 — 3-byte UTF-8 (中文)", () => {
  // "中文" = 6 UTF-8 bytes, 2 UTF-16 code units
  const line = "中文";

  test("UTF-16 offset 1 (start of 文) → byte offset 3", () => {
    expect(utf16ToUtf8(line, 1)).toBe(3);
  });

  test("UTF-16 offset 2 (end) → byte offset 6", () => {
    expect(utf16ToUtf8(line, 2)).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// utf16ToUtf8 — 4-byte UTF-8 / surrogate pairs
// ---------------------------------------------------------------------------
describe("utf16ToUtf8 — 4-byte UTF-8 (emoji)", () => {
  // "a🎉b" = 6 UTF-8 bytes, 4 UTF-16 code units
  const line = "a🎉b";

  test("UTF-16 offset 1 (start of 🎉) → byte offset 1", () => {
    expect(utf16ToUtf8(line, 1)).toBe(1);
  });

  test("UTF-16 offset 3 (start of b) → byte offset 5", () => {
    expect(utf16ToUtf8(line, 3)).toBe(5);
  });

  test("UTF-16 offset 4 (end) → byte offset 6", () => {
    expect(utf16ToUtf8(line, 4)).toBe(6);
  });

  // Surrogate pair midpoint: UTF-16 offset 2 lands in the middle of 🎉.
  // JS slice(0,2) grabs the lead surrogate, which is invalid UTF-8 on its own.
  // TextEncoder will encode it as 3 bytes (the lead surrogate U+D83C).
  test("UTF-16 offset 2 (mid-surrogate) — still produces a valid byte count", () => {
    const result = utf16ToUtf8(line, 2);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// utf16ToUtf8 — mixed ASCII + CJK
// ---------------------------------------------------------------------------
describe("utf16ToUtf8 — mixed ASCII + CJK", () => {
  // "Hello, 世界!" = 14 UTF-8 bytes, 10 UTF-16 code units
  const line = "Hello, 世界!";

  test("UTF-16 offset 7 (start of 世) → byte offset 7", () => {
    expect(utf16ToUtf8(line, 7)).toBe(7);
  });

  test("UTF-16 offset 8 (start of 界) → byte offset 10", () => {
    expect(utf16ToUtf8(line, 8)).toBe(10);
  });

  test("UTF-16 offset 9 (start of !) → byte offset 13", () => {
    expect(utf16ToUtf8(line, 9)).toBe(13);
  });

  test("UTF-16 offset 10 (end) → byte offset 14", () => {
    expect(utf16ToUtf8(line, 10)).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// Roundtrip: utf8ToUtf16(utf16ToUtf8(x)) === x for valid offsets
// ---------------------------------------------------------------------------
describe("roundtrip — utf8ToUtf16 ∘ utf16ToUtf8", () => {
  test("roundtrip on ASCII", () => {
    const line = "hello world";
    for (let i = 0; i <= line.length; i++) {
      const bytes = utf16ToUtf8(line, i);
      const back = utf8ToUtf16(line, bytes);
      expect(back).toBe(i);
    }
  });

  test("roundtrip on mixed ASCII + CJK", () => {
    const line = "Hello, 世界!";
    for (let i = 0; i <= line.length; i++) {
      const bytes = utf16ToUtf8(line, i);
      const back = utf8ToUtf16(line, bytes);
      expect(back).toBe(i);
    }
  });

  test("roundtrip on 2-byte chars", () => {
    const line = "café señor";
    for (let i = 0; i <= line.length; i++) {
      const bytes = utf16ToUtf8(line, i);
      const back = utf8ToUtf16(line, bytes);
      expect(back).toBe(i);
    }
  });

  test("roundtrip on emoji", () => {
    const line = "a🎉b🚀c";
    // Iterate only at safe code-unit boundaries (skip surrogate trail).
    for (let i = 0; i <= line.length; ) {
      const bytes = utf16ToUtf8(line, i);
      const back = utf8ToUtf16(line, bytes);
      expect(back).toBe(i);

      const cp = line.codePointAt(i)!;
      i += cp > 0xffff ? 2 : 1;
    }
  });
});

// ---------------------------------------------------------------------------
// Roundtrip: utf16ToUtf8(utf8ToUtf16(x)) === x for valid byte offsets
// ---------------------------------------------------------------------------
describe("roundtrip — utf16ToUtf8 ∘ utf8ToUtf16", () => {
  test("roundtrip on ASCII bytes", () => {
    const line = "hello";
    for (let b = 0; b <= line.length; b++) {
      const chars = utf8ToUtf16(line, b);
      const back = utf16ToUtf8(line, chars);
      expect(back).toBe(b);
    }
  });

  test("roundtrip on CJK bytes", () => {
    const line = "中文";
    // Byte offsets 0, 3, 6 are valid character boundaries.
    const boundaries = [0, 3, 6];
    for (const b of boundaries) {
      const chars = utf8ToUtf16(line, b);
      const back = utf16ToUtf8(line, chars);
      expect(back).toBe(b);
    }
  });

  test("roundtrip on mixed bytes", () => {
    const line = "Hello, 世界!";
    // Valid byte boundaries: 0,1,2,3,4,5,6,7,10,13,14
    const boundaries = [0, 1, 2, 3, 4, 5, 6, 7, 10, 13, 14];
    for (const b of boundaries) {
      const chars = utf8ToUtf16(line, b);
      const back = utf16ToUtf8(line, chars);
      expect(back).toBe(b);
    }
  });
});

// ---------------------------------------------------------------------------
// getLineText
// ---------------------------------------------------------------------------
describe("getLineText", () => {
  test("extracts first line", () => {
    expect(getLineText("hello\nworld", 0)).toBe("hello");
  });

  test("extracts second line", () => {
    expect(getLineText("hello\nworld", 1)).toBe("world");
  });

  test("single line without newline", () => {
    expect(getLineText("hello", 0)).toBe("hello");
  });

  test("out of range returns empty string", () => {
    expect(getLineText("hello", 5)).toBe("");
  });

  test("negative line returns empty string", () => {
    expect(getLineText("hello", -1)).toBe("");
  });
});
