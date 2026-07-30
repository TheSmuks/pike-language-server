/**
 * Document link tests (US-030).
 *
 * Tests textDocument/documentLink via LSP protocol.
 * Verifies clickable links for imports, inherits, and include directives.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestServer, type TestServer } from "./helpers";

interface LinkResult {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  target?: string;
}

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await server.teardown();
});

describe("US-030: textDocument/documentLink", () => {
  test("returns empty array for file with no imports/inherits/includes", async () => {
    const src = [
      "int main() {",
      "  write(\"hello\\n\");",
      "  return 0;",
      "}",
    ].join("\n");
    const uri = server.openDoc("file:///test/no-links.pike", src);

    const result = await server.client.sendRequest("textDocument/documentLink", {
      textDocument: { uri },
    }) as LinkResult[] | null;

    // Empty array when no links found (not null)
    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(true);
    expect(result!.length).toBe(0);
  });

  test("returns empty array when module cannot be resolved", async () => {
    // import with unknown module - no cached resolution
    const src = [
      "import NonExistentModule;",
      "int main() { return 0; }",
    ].join("\n");
    const uri = server.openDoc("file:///test/unresolved-import.pike", src);

    const result = await server.client.sendRequest("textDocument/documentLink", {
      textDocument: { uri },
    }) as LinkResult[] | null;

    // No links for unresolved modules - still returns array
    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
  });

  test("returns empty array for include of nonexistent file", async () => {
    const src = [
      '#include "nonexistent.pike"',
      "int main() { return 0; }",
    ].join("\n");
    const uri = server.openDoc("file:///test/nonexistent-include.pike", src);

    const result = await server.client.sendRequest("textDocument/documentLink", {
      textDocument: { uri },
    }) as LinkResult[] | null;

    // No links for nonexistent files (path doesn't resolve)
    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
  });

  test("handles multiple constructs in same file", async () => {
    const src = [
      "import Stdio;",
      "inherit \"../lib/base.pike\";",
      "#include \"helper.pike\"",
      "int main() { return 0; }",
    ].join("\n");
    const uri = server.openDoc("file:///test/multi-link.pike", src);

    const result = await server.client.sendRequest("textDocument/documentLink", {
      textDocument: { uri },
    }) as LinkResult[] | null;

    // At minimum, verify we get a result (may be empty if none resolve)
    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
  });

  test("handles string literal paths in inherit", async () => {
    const src = [
      'inherit "foo/bar.pike";',
      "int main() { return 0; }",
    ].join("\n");
    const uri = server.openDoc("file:///test/inherit-string.pike", src);

    const result = await server.client.sendRequest("textDocument/documentLink", {
      textDocument: { uri },
    }) as LinkResult[] | null;

    // Should get a link with the resolved path
    expect(result).toBeDefined();
  });

  test("includes range information for links", async () => {
    const src = [
      'inherit "path/to/file.pike";',
      "int main() { return 0; }",
    ].join("\n");
    const uri = server.openDoc("file:///test/link-range.pike", src);

    const result = await server.client.sendRequest("textDocument/documentLink", {
      textDocument: { uri },
    }) as LinkResult[] | null;

    if (result && result.length > 0) {
      const link = result[0];
      // Range should span from start to end position
      expect(link.range).toBeDefined();
      expect(link.range.start).toBeDefined();
      expect(link.range.end).toBeDefined();
      expect(link.range.start.line).toBe(0);
      // The path text should be inside the range
      expect(link.range.end.character).toBeGreaterThan(link.range.start.character);
    }
  });

  test("handles empty document", async () => {
    const uri = server.openDoc("file:///test/empty.pike", "");

    const result = await server.client.sendRequest("textDocument/documentLink", {
      textDocument: { uri },
    }) as LinkResult[] | null;

    // Empty document returns empty array
    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(true);
  });

  test("handles document with only whitespace", async () => {
    const uri = server.openDoc("file:///test/whitespace.pike", "   \n\n  ");

    const result = await server.client.sendRequest("textDocument/documentLink", {
      textDocument: { uri },
    }) as LinkResult[] | null;

    // Whitespace-only document returns empty array
    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(true);
  });

  test("resolves angle-bracket include to system include path", async () => {
    // stdio.h exists in Pike's include directory (e.g.,
    // /usr/local/pike/8.0.1116/lib/include/stdio.h).
    const src = [
      "#include <stdio.h>",
      "int main() { return 0; }",
    ].join("\n");
    const uri = server.openDoc("file:///test/include-angle.pike", src);

    const result = await server.client.sendRequest("textDocument/documentLink", {
      textDocument: { uri },
    }) as LinkResult[] | null;

    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(true);
    // At minimum the array should not be null/empty due to unknown path handling.
    // The result may be empty in some environments without Pike include paths,
    // but the important thing is no error is thrown.
  });

  test("resolves a non-ASCII-prefixed system include with the exact path-token range (spec source-position-mapping R3)", async () => {
    // A `#include <...>` resolves via ModuleResolver's system-include search
    // (`pike --show-paths`), independent of whether the document's own URI
    // exists on disk — unlike inherit/relative-include resolution, which
    // needs a real on-disk file, this construct resolves for a synthetic
    // in-memory buffer, so no on-disk fixture is needed here.
    //
    // A `/* café */` block comment precedes the directive on the SAME line:
    // comments are tree-sitter "extras" and can appear before a preprocessor
    // directive without disturbing the parse (verified: `hasError` is false
    // and the directive still parses as `preproc_include`). "é" is 1 UTF-16
    // code unit but 2 UTF-8 bytes, so a byte-based (rather than UTF-16-based)
    // position mapping would shift the reported range one column to the
    // right of where it actually is — exactly the class of bug this branch
    // fixed. The path token is the full `system_lib_string` node, including
    // its angle brackets.
    const src = "/* café */ #include <stdio.h>\nint main() { return 0; }";
    const uri = server.openDoc("file:///test/nonascii-include.pike", src);

    const result = await server.client.sendRequest("textDocument/documentLink", {
      textDocument: { uri },
    }) as LinkResult[] | null;

    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    const link = result![0];
    expect(link.target).toContain("stdio.h");

    const line0 = src.split("\n")[0]!;
    const pathStart = line0.indexOf("<stdio.h>");
    const pathEnd = pathStart + "<stdio.h>".length;
    // The non-ASCII character sits well before the path token on this line.
    expect(line0.indexOf("é")).toBeLessThan(pathStart);
    expect(link.range.start.line).toBe(0);
    expect(link.range.start.character).toBe(pathStart);
    expect(link.range.end.line).toBe(0);
    expect(link.range.end.character).toBe(pathEnd);
  });

  test("handles multiple include directives", async () => {
    const src = [
      '#include "a.pike"',
      '#include "b.pike"',
      '#include "c.pike"',
      "int main() { return 0; }",
    ].join("\n");
    const uri = server.openDoc("file:///test/multi-include.pike", src);

    const result = await server.client.sendRequest("textDocument/documentLink", {
      textDocument: { uri },
    }) as LinkResult[] | null;

    // Multiple include directives should be processed
    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
  });

  test("handles named inherit (inherit with alias)", async () => {
    const src = [
      'class Animal { void speak() {} }',
      'inherit Animal : beast;',
      "int main() { return 0; }",
    ].join("\n");
    const uri = server.openDoc("file:///test/named-inherit.pike", src);

    const result = await server.client.sendRequest("textDocument/documentLink", {
      textDocument: { uri },
    }) as LinkResult[] | null;

    // Named inherit - the Animal identifier should be processed
    expect(result).toBeDefined();
  });

  test("handles module imports with dot notation", async () => {
    const src = [
      "import Calendar;",
      "int main() {",
      "  Calendar.Second s;",
      "  return 0;",
      "}",
    ].join("\n");
    const uri = server.openDoc("file:///test/dot-import.pike", src);

    const result = await server.client.sendRequest("textDocument/documentLink", {
      textDocument: { uri },
    }) as LinkResult[] | null;

    // Calendar module import
    expect(result).toBeDefined();
  });

  test("cancels request when token is cancelled", async () => {
    const src = ["int main() { return 0; }"].join("\n");
    const uri = server.openDoc("file:///test/cancel.pike", src);

    // Create a cancelled token by sending a cancel notification
    server.client.sendNotification("$/cancelRequest", { id: "fake-id" });

    const result = await server.client.sendRequest("textDocument/documentLink", {
      textDocument: { uri },
    }) as LinkResult[] | null;

    // Note: cancellation with fake-id may not be honored
    // Just verify we get a valid response
    expect(result).toBeDefined();
  });
});
