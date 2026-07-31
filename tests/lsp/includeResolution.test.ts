/**
 * `#include` resolution + `#define` macro tests.
 *
 * Covers:
 * - `#define` macros modeled as `macro` declarations (object- vs function-like).
 * - `#include` directives modeled as `include` declarations, excluded from
 *   completable scope symbols.
 * - wireIncludes merging an included file's top-level symbols (declarations +
 *   macros) into the includer's file scope, including an out-of-workspace `../`
 *   header (upward relative traversal).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { initParser, parse } from "../../server/src/parser";
import {
  buildSymbolTable,
  getSymbolsInScope,
  type Declaration,
} from "../../server/src/features/symbolTable";
import { WorkspaceIndex, ModificationSource } from "../../server/src/features/workspaceIndex";
import { createTestServer, type TestServer } from "./helpers";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

interface LinkResult {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  target?: string;
}

beforeAll(async () => {
  await initParser();
});

// ---------------------------------------------------------------------------
// #define macros
// ---------------------------------------------------------------------------

describe("#define macros", () => {
  test("object-like and function-like macros become macro declarations", () => {
    const src = '#define MAX 10\n#define SQ(x) ((x)*(x))\nint g;';
    const table = buildSymbolTable(parse(src), "file:///t.pike", 1, undefined, src);

    const macros = table.declarations.filter(d => d.kind === "macro");
    expect(macros.map(m => m.name).sort()).toEqual(["MAX", "SQ"]);

    const max = macros.find(m => m.name === "MAX")!;
    const sq = macros.find(m => m.name === "SQ")!;
    expect(max.functionLike).toBe(false);
    expect(sq.functionLike).toBe(true);

    // Name range points at the macro name, not the whole directive.
    expect(max.nameRange.start).toEqual({ line: 0, character: 8 });
    expect(max.nameRange.end).toEqual({ line: 0, character: 11 });
  });

  test("macros are visible in scope; the include directive is not", () => {
    const src = '#define MAX 10\n#include "x.h"\nint g;';
    const table = buildSymbolTable(parse(src), "file:///t.pike", 1, undefined, src);

    const names = getSymbolsInScope(table, 2, 5).map((d: Declaration) => d.name);
    expect(names).toContain("MAX");
    // The raw include path text must never surface as a completion.
    expect(names).not.toContain('"x.h"');
  });

  test("identifiers inside a macro body resolve to their declarations", () => {
    const src = 'int helper(int a) { return a; }\n#define CALL_IT(x) helper(x)\n';
    const table = buildSymbolTable(parse(src), "file:///t.pike", 1, undefined, src);

    const helper = table.declarations.find(d => d.name === "helper")!;
    // Column 19 is `helper` inside the body, not the macro name at column 8.
    const bodyRef = table.references.find(
      r => r.name === "helper" && r.loc.line === 1 && r.loc.character === 19,
    );
    expect(bodyRef).toBeDefined();
    expect(bodyRef!.resolvesTo).toBe(helper.id);
  });

  test("a macro parameter used in the body resolves to the parameter, not a same-named symbol", () => {
    // `x` at file scope and `x` as the macro's parameter are unrelated; binding
    // the body occurrence to the global would make rename rewrite the macro.
    // Pike agrees: with `int X = 100;` and `#define F(X) (X + X)`, `F(1)` is 2.
    //
    // This used to be enforced by collecting no reference at all, which kept
    // the body from resolving anywhere — the parameter is now a declaration of
    // its own, so the guarantee is positive rather than an absence.
    const src = 'int x;\n#define DOUBLE(x) ((x)+(x))\n';
    const table = buildSymbolTable(parse(src), "file:///t.pike", 1, undefined, src);

    const global = table.declarations.find(d => d.name === "x" && d.kind === "variable")!;
    const param = table.declarations.find(d => d.kind === "macro_parameter")!;
    expect(param.name).toBe("x");

    const onLine1 = table.references.filter(r => r.loc.line === 1 && r.name === "x");
    expect(onLine1.length).toBe(2);
    for (const ref of onLine1) {
      expect(ref.resolvesTo).toBe(param.id);
      expect(ref.resolvesTo).not.toBe(global.id);
    }
  });

  test("a macro parameter is scoped to its own #define", () => {
    // Two macros may bind the same name, and a use in one body must not reach
    // the other's parameter.
    const src = '#define A(v) (v)\n#define B(v) (v + 1)\n';
    const table = buildSymbolTable(parse(src), "file:///t.pike", 1, undefined, src);

    const params = table.declarations.filter(d => d.kind === "macro_parameter");
    expect(params.length).toBe(2);
    expect(params[0].id).not.toBe(params[1].id);

    const bodyRefs = table.references.filter(r => r.name === "v");
    expect(bodyRefs.length).toBe(2);
    // Each body reaches the parameter declared on its own line.
    for (const ref of bodyRefs) {
      const target = table.declById.get(ref.resolvesTo!)!;
      expect(target.nameRange.start.line).toBe(ref.loc.line);
    }
  });

  test("a name the macro does not bind still reaches the enclosing scope", () => {
    // The macro scope shadows; it does not seal.
    const src = 'int outer;\n#define USE(v) (v + outer)\n';
    const table = buildSymbolTable(parse(src), "file:///t.pike", 1, undefined, src);

    const outer = table.declarations.find(d => d.name === "outer")!;
    const ref = table.references.find(r => r.name === "outer" && r.loc.line === 1)!;
    expect(ref.resolvesTo).toBe(outer.id);
  });

  test("a keyword in a macro body is not collected as a reference", () => {
    const src = '#define LOOP(X) do { X; } while(0)\n';
    const table = buildSymbolTable(parse(src), "file:///t.pike", 1, undefined, src);

    expect(table.references.map(r => r.name)).not.toContain("do");
    expect(table.references.map(r => r.name)).not.toContain("while");
  });

  test("#include is recorded as an include declaration with the raw path", () => {
    const src = '#include "foo.h"\n#include <bar.h>';
    const table = buildSymbolTable(parse(src), "file:///t.pike", 1, undefined, src);

    const includes = table.declarations.filter(d => d.kind === "include");
    expect(includes.map(i => i.name)).toEqual(['"foo.h"', "<bar.h>"]);
  });
});

// ---------------------------------------------------------------------------
// wireIncludes — merge included symbols
// ---------------------------------------------------------------------------

describe("#include symbol merge", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pike-lsp-include-"));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Index header, then includer; return the includer's merged symbol table. */
  async function indexIncluder(
    root: string,
    headerPath: string,
    headerSrc: string,
    filePath: string,
    fileSrc: string,
  ) {
    const index = new WorkspaceIndex({ workspaceRoot: pathToFileURL(root + "/").href });
    const headerUri = pathToFileURL(headerPath).href;
    const fileUri = pathToFileURL(filePath).href;
    await index.upsertFile(headerUri, 1, parse(headerSrc, headerUri), headerSrc, ModificationSource.DidOpen);
    await index.upsertFile(fileUri, 1, parse(fileSrc, fileUri), fileSrc, ModificationSource.DidOpen);
    return { index, fileUri, headerUri };
  }

  function fileScopeNames(table: { scopes: any[]; declById: Map<number, Declaration> }): Declaration[] {
    const fileScope = table.scopes.find((s: any) => s.kind === "file");
    return fileScope.declarations
      .map((id: number) => table.declById.get(id))
      .filter((d: Declaration | undefined): d is Declaration => d !== undefined);
  }

  test("sibling header symbols (incl. macros) are merged into the includer scope", async () => {
    const dir = join(tempDir, "proj");
    mkdirSync(dir, { recursive: true });
    const headerPath = join(dir, "defs.h");
    const filePath = join(dir, "main.pike");
    const headerSrc = [
      "#define MAX_ITEMS 42",
      "#define SQUARE(x) ((x)*(x))",
      "int shared_counter;",
      'constant GREETING = "hi";',
      "class Widget { int w; }",
    ].join("\n");
    const fileSrc = '#include "defs.h"\nint main() { return MAX_ITEMS; }';
    writeFileSync(headerPath, headerSrc);
    writeFileSync(filePath, fileSrc);

    const { index, fileUri } = await indexIncluder(
      dir, headerPath, headerSrc, filePath, fileSrc,
    );
    const table = index.getSymbolTable(fileUri)!;
    const merged = fileScopeNames(table);
    const byName = new Map(merged.map(d => [d.name, d]));

    for (const name of ["MAX_ITEMS", "SQUARE", "shared_counter", "GREETING", "Widget"]) {
      expect(byName.has(name)).toBe(true);
      expect(byName.get(name)!.sourceUri).toBe(pathToFileURL(headerPath).href);
    }
    expect(byName.get("MAX_ITEMS")!.kind).toBe("macro");
    expect(byName.get("Widget")!.kind).toBe("class");
  });

  test("out-of-workspace `../` header resolves and merges (upward traversal)", async () => {
    // Workspace root is proj2/inner; the header lives one level above it.
    const root = join(tempDir, "proj2", "inner");
    const sub = join(root, "x");
    mkdirSync(sub, { recursive: true });
    const headerPath = join(tempDir, "proj2", "shared.h");
    const filePath = join(sub, "file.pike");
    writeFileSync(headerPath, "#define SHARED_FLAG 1\nint helper() { return SHARED_FLAG; }");
    writeFileSync(filePath, '#include "../../shared.h"\nint main() { return helper(); }');

    const index = new WorkspaceIndex({ workspaceRoot: pathToFileURL(root + "/").href });
    const headerUri = pathToFileURL(headerPath).href;
    const fileUri = pathToFileURL(filePath).href;
    // Resolve + index the header on demand (it is outside the workspace root).
    const resolvedHeader = await index.resolveInclude('"../../shared.h"', false, fileUri);
    expect(resolvedHeader).toBe(headerUri);

    const hsrc = "#define SHARED_FLAG 1\nint helper() { return SHARED_FLAG; }";
    const fsrc = '#include "../../shared.h"\nint main() { return helper(); }';
    await index.upsertFile(headerUri, 1, parse(hsrc, headerUri), hsrc, ModificationSource.DidOpen);
    await index.upsertFile(fileUri, 1, parse(fsrc, fileUri), fsrc, ModificationSource.DidOpen);

    const table = index.getSymbolTable(fileUri)!;
    const names = fileScopeNames(table).map(d => d.name);
    expect(names).toContain("SHARED_FLAG");
    expect(names).toContain("helper");
  });

  test("`#include \"/etc/passwd\"` (non-source, outside roots) does not resolve", async () => {
    const root = join(tempDir, "proj3");
    mkdirSync(root, { recursive: true });
    const index = new WorkspaceIndex({ workspaceRoot: pathToFileURL(root + "/").href });
    const fileUri = pathToFileURL(join(root, "evil.pike")).href;
    const resolved = await index.resolveInclude('"/etc/passwd"', false, fileUri);
    expect(resolved).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// documentLink — out-of-workspace #include
// ---------------------------------------------------------------------------

describe("documentLink — out-of-workspace #include", () => {
  let tempDir: string;
  let server: TestServer;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "pike-lsp-dlink-"));
    // Workspace root is tempDir/proj; the header lives one level above it, so
    // the link target escapes the workspace — previously rejected outright.
    mkdirSync(join(tempDir, "proj"), { recursive: true });
    writeFileSync(join(tempDir, "shared.h"), "#define SHARED 1\n");
    server = await createTestServer({ rootUri: pathToFileURL(join(tempDir, "proj")).href });
  });

  afterAll(async () => {
    await server.teardown();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('provides a link for `#include "../shared.h"` outside the workspace', async () => {
    const fileUri = pathToFileURL(join(tempDir, "proj", "main.pike")).href;
    server.openDoc(fileUri, '#include "../shared.h"\nint main() { return SHARED; }');

    const result = await server.client.sendRequest("textDocument/documentLink", {
      textDocument: { uri: fileUri },
    }) as LinkResult[] | null;

    expect(Array.isArray(result)).toBe(true);
    const target = result!.find(l => l.target?.endsWith("shared.h"))?.target;
    expect(target).toBe(pathToFileURL(join(tempDir, "shared.h")).href);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: completion surfaces included symbols after closure indexing
// ---------------------------------------------------------------------------

describe("completion — included symbols (end-to-end)", () => {
  let tempDir: string;
  let server: TestServer;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "pike-lsp-inc-complete-"));
    // Header is a workspace sibling so the on-demand dependency closure indexes
    // it from disk when the includer opens.
    writeFileSync(join(tempDir, "consts.h"), "#define LIMIT 99\nconstant TAG = \"t\";\n");
    server = await createTestServer({ rootUri: pathToFileURL(tempDir).href });
  });

  afterAll(async () => {
    await server.teardown();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("a header macro is offered as a completion in the includer", async () => {
    const fileUri = pathToFileURL(join(tempDir, "main.pike")).href;
    // Cursor at end of the `return ` expression on line 2.
    const src = '#include "consts.h"\nint main() {\n  return L\n}';
    server.openDoc(fileUri, src);

    // Wait for fire-and-forget dependency-closure indexing + rewire to settle.
    await new Promise(resolve => setTimeout(resolve, 300));

    const result = await server.client.sendRequest("textDocument/completion", {
      textDocument: { uri: fileUri },
      position: { line: 2, character: 9 },
    }) as { items?: { label: string }[] } | { label: string }[] | null;

    const items = Array.isArray(result) ? result : (result?.items ?? []);
    const labels = items.map(i => i.label);
    expect(labels).toContain("LIMIT");
    expect(labels).toContain("TAG");
  });
});
