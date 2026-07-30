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
});
