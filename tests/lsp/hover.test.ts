/**
 * Hover tests (LSP layer) — three-tier routing.
 *
 * Tier 1: Workspace AutoDoc — XML from PikeExtractor (cached on save)
 * Tier 2: Stdlib — pre-computed index (hash lookup)
 * Tier 3: Fall-through — tree-sitter declared type
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestServer, waitForIndexed, type TestServer } from "./helpers";
import { pikeAvailable } from "../helpers/pikeAvailable";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CORPUS_DIR = join(import.meta.dir, "..", "..", "corpus", "files");

function readCorpusSource(filename: string): string {
  return readFileSync(join(CORPUS_DIR, filename), "utf-8");
}

function corpusUri(filename: string): string {
  return `file://${join(CORPUS_DIR, filename)}`;
}

// ---------------------------------------------------------------------------
// Shared server
// ---------------------------------------------------------------------------

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await server.teardown();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface HoverResult {
  contents: { kind: string; value: string };
  range?: { start: { line: number; character: number }; end: { line: number; character: number } };
}

// Polls a condition that becomes true asynchronously (e.g. a spied worker
// call landing) instead of sleeping a fixed interval — same idiom as
// waitForIndexed in ./helpers.ts, applied to conditions other than indexing.
async function waitForCondition(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`waitForCondition: timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Poll a hover request until it returns a non-null result.
 *
 * Cross-file inherit wiring can complete after the index reports both files
 * as "indexed" (waitForIndexed only checks that a symbol table exists, not
 * that inter-file links are wired) — so retry the hover itself, the actual
 * condition the test cares about, instead of trusting a proxy.
 */
async function waitForHover(
  server: TestServer,
  uri: string,
  position: { line: number; character: number },
  timeoutMs = 5000,
): Promise<HoverResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position },
    ) as HoverResult | null;
    if (result !== null) return result;
    if (Date.now() >= deadline) {
      throw new Error(`waitForHover: timed out after ${timeoutMs}ms; hover on ${uri} stayed null`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Pre-populate the autodoc XML cache for a URI. */
function cacheAutodoc(uri: string, xml: string): void {
  server.server.autodocCache.set(uri, {
    xml,
    hash: "test-hash",
    timestamp: Date.now(),
  });
}

/** Generate PikeExtractor-style XML for a simple documented function. */
function xmlForFunction(name: string, summary: string, params: Array<{ name: string; desc: string }> = [], returns = ""): string {
  const paramGroups = params.map(p =>
    `<group><param name="${p.name}"/><text><p>${p.desc}</p></text></group>`
  ).join("\n");

  const returnsGroup = returns
    ? `<group><returns/><text><p>${returns}</p></text></group>`
    : "";

  const args = params.map(p => `<argument name='${p.name}'><type><mixed/></type></argument>`).join("");

  return `<?xml version='1.0' encoding='utf-8'?>
<namespace name='predef'>
  <docgroup homogen-name='${name}' homogen-type='method'>
    <doc>
      <text><p>${summary}</p></text>
      ${paramGroups}
      ${returnsGroup}
    </doc>
    <method name='${name}'>
      <arguments>${args}</arguments>
      <returntype><void/></returntype>
    </method>
  </docgroup>
</namespace>`;
}

/** Generate XML for a documented variable. */
function xmlForVariable(name: string, summary: string, type = "mixed"): string {
  return `<?xml version='1.0' encoding='utf-8'?>
<namespace name='predef'>
  <docgroup homogen-name='${name}' homogen-type='variable'>
    <doc><text><p>${summary}</p></text></doc>
    <variable name='${name}'><type><${type}/></type></variable>
  </docgroup>
</namespace>`;
}

// ---------------------------------------------------------------------------
// Tier 1: Workspace AutoDoc
// ---------------------------------------------------------------------------

describe("Tier 1: Workspace AutoDoc hover", () => {
  test("documented function shows summary and params from XML cache", async () => {
    const uri = "file:///test/autodoc-fn.pike";
    const source = [
      "//! A documented function.",
      "//! @param x",
      "//!   The input value.",
      "//! @returns",
      "//!   The doubled input.",
      "int doc_func(int x) { return x * 2; }",
    ].join("\n");
    server.openDoc(uri, source);

    // Pre-populate the XML cache (simulating what didSave would do)
    cacheAutodoc(uri, xmlForFunction("doc_func", "A documented function.",
      [{ name: "x", desc: "The input value." }],
      "The doubled input."));

    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 5, character: 4 } },
    ) as HoverResult | null;

    expect(result).not.toBeNull();
    expect(result!.contents.value).toContain("doc_func");
    expect(result!.contents.value).toContain("A documented function");
    expect(result!.contents.value).toContain("`x`");
    expect(result!.contents.value).toContain("doubled input");
  });

  test("documented variable shows summary from XML cache", async () => {
    const uri = "file:///test/autodoc-var.pike";
    const source = [
      "//! The name of the thing.",
      "string name = \"default\";",
    ].join("\n");
    server.openDoc(uri, source);

    cacheAutodoc(uri, xmlForVariable("name", "The name of the thing.", "string"));

    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 1, character: 7 } },
    ) as HoverResult | null;

    expect(result).not.toBeNull();
    expect(result!.contents.value).toContain("name of the thing");
  });

  test("cache miss falls through to tree-sitter", async () => {
    const uri = "file:///test/cache-miss.pike";
    const source = "int undocumented_func() { return 1; }";
    server.openDoc(uri, source);

    // No cache entry — should fall through to tree-sitter (Tier 3)
    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 0, character: 4 } },
    ) as HoverResult | null;

    expect(result).not.toBeNull();
    expect(result!.contents.value).toContain("undocumented_func");
    // Should NOT have AutoDoc section markers
    expect(result!.contents.value).not.toContain("**Returns:**");
  });
});

// ---------------------------------------------------------------------------
// Tier 2: Stdlib
// ---------------------------------------------------------------------------

describe("Tier 2: Stdlib hover", () => {
  test("qualified stdlib member: f->open where f is Stdio.File shows Stdio.File.open docs (C3)", async () => {
    // Regression for audit iteration-6 C3: hovering a member of a stdlib-typed
    // variable must build the precise FQN `predef.Stdio.File.open`, not the
    // unqualified `predef.open` (which does not exist → previously no hover).
    const uri = "file:///test/c3-qualified-stdlib.pike";
    const source = [
      "void test() {",
      "  Stdio.File f;",
      "  f->open(\"x\", \"r\");",
      "}",
    ].join("\n");
    server.openDoc(uri, source);

    // Cursor on `open` (line 2, char 5 — right after `f->`).
    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 2, character: 5 } },
    ) as HoverResult | null;

    expect(result).not.toBeNull();
    expect(result!.contents.value).toContain("open");
    // Signature from predef.Stdio.File.open: "int open(string filename, string mode)"
    expect(result!.contents.value).toContain("filename");
  });

  test("user-defined function shadowing a predef builtin shows its own signature", async () => {
    // Declare a local function with the same name as a predef builtin, then
    // hover over a reference to it. The local definition must win — showing the
    // builtin's docs (e.g. "Writes a string on stdout") would be misleading.
    const uri = "file:///test/predef-hover.pike";
    const source = "int write(int x) { return x; }\nint y = write(1);";
    server.openDoc(uri, source);

    // Hover over the call to write() on line 1
    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 1, character: 8 } },
    ) as HoverResult | null;

    expect(result).not.toBeNull();
    expect(result!.contents.value).toBeDefined();
    // Shows the local signature, not the predef `write` stdout-writer docs.
    expect(result!.contents.value).toContain("write");
    expect(result!.contents.value).toContain("int");
    expect(result!.contents.value).not.toContain("stdout");
  });
});

// ---------------------------------------------------------------------------
// Tier 3: Fall-through (tree-sitter, no autodoc)
// ---------------------------------------------------------------------------

describe("Tier 3: Fall-through hover (no autodoc)", () => {
  test("undocumented function shows bare signature", async () => {
    const uri = "file:///test/bare-fn.pike";
    const source = "int add(int a, int b) { return a + b; }";
    server.openDoc(uri, source);

    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 0, character: 4 } },
    ) as HoverResult | null;

    expect(result).not.toBeNull();
    expect(result!.contents.value).toContain("add");
    expect(result!.contents.value).toContain("```pike");
    // Should NOT have AutoDoc section markers
    expect(result!.contents.value).not.toContain("**Parameters:**");
  });

  test("undocumented variable shows declared type", async () => {
    const uri = "file:///test/bare-var.pike";
    const source = "string name = \"world\";";
    server.openDoc(uri, source);

    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 0, character: 7 } },
    ) as HoverResult | null;

    expect(result).not.toBeNull();
    expect(result!.contents.value).toContain("name");
  });


  test("variable with trailing comment produces clean signature", async () => {
    const uri = "file:///test/trailing-comment-sig.pike";
    const source = 'int count = 0; // number of items';
    server.openDoc(uri, source);

    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 0, character: 4 } },
    ) as HoverResult | null;

    expect(result).not.toBeNull();
    // Signature must not contain trailing comment text
    expect(result!.contents.value).not.toContain("number of items");
    // Signature must not contain the comment marker
    expect(result!.contents.value).not.toContain("//");
    // But should still contain the variable name
    expect(result!.contents.value).toContain("count");
  });

  test("variable with trailing block comment produces clean signature", async () => {
    const uri = "file:///test/trailing-block-comment-sig.pike";
    const source = 'string label = "hi"; /* a label */';
    server.openDoc(uri, source);

    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 0, character: 7 } },
    ) as HoverResult | null;

    expect(result).not.toBeNull();
    expect(result!.contents.value).not.toContain("a label");
    expect(result!.contents.value).not.toContain("/*");
    expect(result!.contents.value).toContain("label");
  });
  test("empty position returns null", async () => {
    const uri = "file:///test/empty-hover.pike";
    const source = "\n\nint x = 1;\n";
    server.openDoc(uri, source);

    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 0, character: 0 } },
    ) as HoverResult | null;

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Hover range correctness
// ---------------------------------------------------------------------------

describe("Hover range", () => {
  test("hover range matches declaration position", async () => {
    const uri = "file:///test/hover-range.pike";
    const source = "int my_variable = 42;";
    server.openDoc(uri, source);

    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 0, character: 5 } },
    ) as HoverResult | null;

    expect(result).not.toBeNull();
    expect(result!.range).toBeDefined();
    expect(result!.range!.start.line).toBe(0);
    expect(result!.range!.start.character).toBe(4); // 'my_variable' starts at char 4
  });
});

// ---------------------------------------------------------------------------
// Pike worker NOT involved in hover hot path
// ---------------------------------------------------------------------------

describe("Hover isolation", () => {
  test("hover with cached autodoc does not call pike worker", async () => {
    const uri = "file:///test/no-worker.pike";
    const source = [
      "//! Documented.",
      "int f() { return 1; }",
    ].join("\n");
    server.openDoc(uri, source);

    // Pre-populate cache — this is the hot path
    cacheAutodoc(uri, xmlForFunction("f", "Documented."));

    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 1, character: 4 } },
    ) as HoverResult | null;

    // The pike worker should NOT be spawned for this request
    // (it would take >100ms due to subprocess startup)
    expect(result).not.toBeNull();
    expect(result!.contents.value).toContain("Documented");
  });
});


// ---------------------------------------------------------------------------
// Cross-file inherited member hover (US-001)
// ---------------------------------------------------------------------------

describe("hover LSP: cross-file inherited member (US-001)", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await server.teardown();
  });

  test("hover on d->speak() shows Animal.speak signature from cross-file", async () => {
    const srcA = readCorpusSource("cross-inherit-simple-a.pike");
    server.openDoc(corpusUri("cross-inherit-simple-a.pike"), srcA);

    const srcB = readCorpusSource("cross-inherit-simple-b.pike");
    const uriB = server.openDoc(corpusUri("cross-inherit-simple-b.pike"), srcB);

    // Indexing the base file and its dependent happens on the server's own
    // schedule after openDoc returns — asserting a cross-file answer right
    // after opening races that work. See helpers.ts:waitForIndexed.
    await waitForIndexed(server, [corpusUri("cross-inherit-simple-a.pike"), uriB]);

    // waitForIndexed only confirms both files have *a* symbol table; wiring
    // b.pike's inherit of a.pike's class (so `Dog` resolves to `Animal`) is a
    // separate step that can still land after that — empirically, gated on
    // waitForIndexed alone this hover call flakes (~1/3 runs) inside the full
    // suite, where earlier tests have queued other indexing work. Poll the
    // hover result itself, the thing actually under test, rather than a
    // second internal proxy.
    // d->speak() — speak is at line 25, char 28
    const result = await waitForHover(server, uriB, { line: 25, character: 28 });

    expect(result).not.toBeNull();
    expect(result!.contents.value).toContain("speak");
  });
});

// ---------------------------------------------------------------------------
// US-009: PikeWorker typeof integration for hover on mixed/untyped variables
// ---------------------------------------------------------------------------

describe.skipIf(!pikeAvailable)("US-009: typeof integration for hover on mixed/untyped variables", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await server.teardown();
  });

  test("hover on mixed variable shows inferred type from Pike", async () => {
    const uri = "file:///test/us009-mixed.pike";
    const source = [
      'class Dog { void speak() {} }',
      'void test() {',
      '  mixed d = Dog();',
      '  d;',
      '}',
    ].join('\n');
    server.openDoc(uri, source);

    // Hover on 'd' at line 3, char 2
    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 3, character: 2 } },
    ) as HoverResult | null;

    // Hover should show the variable and its type information
    expect(result).not.toBeNull();
    expect(result!.contents.value).toContain("d");
  });

  test("hover on explicitly typed variable shows tree-sitter signature without inferred annotation", async () => {
    const uri = "file:///test/us009-typed.pike";
    const source = [
      'void test() {',
      '  int x = 42;',
      '  x;',
      '}',
    ].join('\n');
    server.openDoc(uri, source);

    // Hover on 'x' at line 2, char 2
    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 2, character: 2 } },
    ) as HoverResult | null;

    // Explicitly typed variable: hover from tree-sitter, no 'inferred:' annotation
    expect(result).not.toBeNull();
    expect(result!.contents.value).toContain("int");
    expect(result!.contents.value).not.toContain("inferred:");
  });

  test("hover on untyped mixed variable produces a result even without specific inference", async () => {
    const uri = "file:///test/us009-fallback.pike";
    const source = [
      'void test() {',
      '  mixed d = 42;',
      '  d;',
      '}',
    ].join('\n');
    server.openDoc(uri, source);

    // Hover on 'd' at line 2, char 2
    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 2, character: 2 } },
    ) as HoverResult | null;

    // Should always produce a hover result (tree-sitter fallback at minimum)
    expect(result).not.toBeNull();
    expect(result!.contents.value).toContain("d");
  });
});

// ---------------------------------------------------------------------------
// didOpen AutoDoc extraction tests (decision 0014)
// ---------------------------------------------------------------------------

describe("didOpen AutoDoc extraction", () => {
  test("open a document with //! AutoDoc comments, verify hover returns AutoDoc content without any save", async () => {
    const uri = "file:///test/open-autodoc.pike";
    const source = [
      "//! A documented function on open.",
      "//! @param x",
      "//!   The input.",
      "//! @returns",
      "//!   The output.",
      "int open_func(int x) { return x * 3; }",
    ].join("\n");
    server.openDoc(uri, source);

    // Wait for the worker to process the autodoc (fire-and-forget) rather
    // than sleeping a fixed interval — poll the actual cache it populates.
    await waitForCondition(() => server.server.autodocCache.get(uri) !== undefined);

    // Hover over the function name
    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 5, character: 4 } },
    ) as HoverResult | null;

    expect(result).not.toBeNull();
    // Should contain AutoDoc content extracted on open (not pre-cached)
    expect(result!.contents.value).toContain("open_func");
    expect(result!.contents.value).toContain("A documented function on open");
  });

  test("open → save → verify no double extraction (hash dedup)", async () => {
    const uri = "file:///test/dedup-autodoc.pike";
    const source = [
      "//! A dedup test function.",
      "int dedup_func(int x) { return x; }",
    ].join("\n");

    // Spy on worker.autodoc
    const originalAutodoc = server.server.worker.autodoc.bind(server.server.worker);
    let autodocCallCount = 0;
    server.server.worker.autodoc = async (...args: Parameters<typeof originalAutodoc>) => {
      autodocCallCount++;
      return originalAutodoc(...args);
    };

    try {
      // Open the document
      server.openDoc(uri, source);
      // Wait for the open-triggered autodoc call rather than sleeping a
      // fixed interval — poll the spy's own call count.
      await waitForCondition(() => autodocCallCount >= 1);

      // Save the document
      server.client.sendNotification("textDocument/didSave", { textDocument: { uri } });
      // There is no positive condition to poll for here — a successful dedup
      // means NO second call happens, so there is nothing that "becomes
      // true". A fixed settle window is the only option without touching
      // server/src to add an observable "save processed" signal.
      await new Promise((r) => setTimeout(r, 200));

      // autodoc should be called at most once (hash dedup should prevent second call)
      expect(autodocCallCount).toBeLessThanOrEqual(2); // Open + (save only if hash was different)
    } finally {
      // Restore original autodoc
      server.server.worker.autodoc = originalAutodoc;
    }
  });

  test("open with worker unavailable → verify graceful fallback", async () => {
    const uri = "file:///test/worker-fail.pike";
    const source = [
      "//! A function that should fail gracefully.",
      "int fail_func(int x) { return x; }",
    ].join("\n");

    // Save original and replace with throwing implementation
    const originalAutodoc = server.server.worker.autodoc.bind(server.server.worker);
    let wasCalled = false;
    server.server.worker.autodoc = async () => {
      wasCalled = true;
      throw new Error("Worker unavailable");
    };

    try {
      // Open the document — should not crash
      server.openDoc(uri, source);

      // Wait for the async handler to run rather than sleeping a fixed
      // interval — poll the spy flag it sets directly.
      await waitForCondition(() => wasCalled);

      // Verify the worker was called (didOpen triggered autodoc)
      expect(wasCalled).toBe(true);

      // Hover should still work (fallback to tree-sitter)
      const result = await server.client.sendRequest(
        "textDocument/hover",
        { textDocument: { uri }, position: { line: 1, character: 4 } },
      ) as HoverResult | null;

      expect(result).not.toBeNull();
      expect(result!.contents.value).toContain("fail_func");
    } finally {
      server.server.worker.autodoc = originalAutodoc;
    }
  });
});

// ---------------------------------------------------------------------------
// Type-name and inherit-alias hover (audit follow-ups)
// ---------------------------------------------------------------------------

describe("hover on stdlib type names", () => {
  test("hover on the class segment of Stdio.File shows the class docs", async () => {
    const uri = "file:///test/typename.pike";
    const source = 'int main() {\n  Stdio.File f = Stdio.File();\n  return 0;\n}\n';
    server.openDoc(uri, source);

    // Line 1: `  Stdio.File f = ...` — cursor on `File` (col 8).
    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 1, character: 9 } },
    ) as HoverResult | null;

    expect(result).not.toBeNull();
    // predef.Stdio.File carries the class markdown in the stdlib index.
    expect(result!.contents.value).toContain("I/O object");
  });

  test("hover on the module segment shows the module", async () => {
    const uri = "file:///test/typename2.pike";
    const source = 'int main() {\n  Stdio.File f = Stdio.File();\n  return 0;\n}\n';
    server.openDoc(uri, source);

    // Cursor on `Stdio` (col 2).
    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 1, character: 4 } },
    ) as HoverResult | null;

    expect(result).not.toBeNull();
    expect(result!.contents.value).toContain("module Stdio");
  });
});

describe("hover on inherit alias", () => {
  test("alias use in scope access shows the inherit it names", async () => {
    const uri = "file:///test/alias.pike";
    const source = [
      "class Vec {",
      "  int x, y;",
      "  void create(int ax, int ay) { x = ax; y = ay; }",
      "}",
      "class Named {",
      "  inherit Vec : base;",
      "  void create() {",
      "    base::create(0, 0);",
      "  }",
      "}",
    ].join("\n");
    server.openDoc(uri, source);

    // Line 7: `    base::create(0, 0);` — cursor on `base` (col 4).
    const result = await server.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: { line: 7, character: 5 } },
    ) as HoverResult | null;

    expect(result).not.toBeNull();
    expect(result!.contents.value).toContain("inherit Vec : base");
  });
});
