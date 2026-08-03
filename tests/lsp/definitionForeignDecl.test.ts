/**
 * Regression: go-to-definition must not answer with a declaration that was
 * cloned into this file's symbol table from another file.
 *
 * `wireInheritance` (scopeBuilder) and `wireIncludes` (includeWiring) copy
 * declarations from inherited/included files into `table.declarations` so that
 * references can resolve to them. Those clones keep the *other* file's line and
 * character coordinates. Every position-based query over `table.declarations`
 * therefore had to exclude them — and did not.
 *
 * The visible bug: CTRL+CLICK on a method defined in the directory
 * `module.pmod` jumped to an unrelated line of an `#include`d header (or of an
 * inherited file), because the click position happened to fall inside a cloned
 * declaration's foreign nameRange.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createTestServer, waitForFileEntry, type TestServer } from "./helpers";
import { initParser, parse } from "../../server/src/parser";
import { WorkspaceIndex, ModificationSource } from "../../server/src/features/workspaceIndex";
import { wireInheritance } from "../../server/src/features/scopeBuilder";
import {
  getDefinitionAt,
  getLocalDeclarationAt,
} from "../../server/src/features/symbolTable";
import { produceCodeLenses } from "../../server/src/features/codeLens";
import { produceSemanticTokens } from "../../server/src/features/semanticTokens";
import { prepareCallHierarchy } from "../../server/src/features/callHierarchy";
import { refineRuntimeTarget } from "../../server/src/features/runtimeTargetRefine";

interface LspLocation {
  uri: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

// ---------------------------------------------------------------------------
// Unit level: position queries over a table with cloned declarations
// ---------------------------------------------------------------------------

// Line 1 col 6-10 is `legs`, line 2 col 7-12 is `speak` — coordinates that
// collide with consumer.pike's own text below.
const ANIMAL_SRC = `class Animal {
  int legs;
  void speak() { }
  void run_around_the_yard() { }
}
`;

const HEADER_SRC = `// header.h line 0
#define HEADER_GUARD 1
int header_counter;
string header_helper(string s) { return s; }
constant HEADER_CONST = 7;
`;

const CONSUMER_SRC = `#include "header.h"
inherit "Animal.pike";
class Dog {
  inherit Animal;
  int mine;
  void go() { mystery_call(); }
}
`;

describe("cloned cross-file declarations are invisible to position queries", () => {
  let root: string;
  let consUri: string;
  let table: import("../../server/src/features/symbolTable").SymbolTable;

  beforeAll(async () => {
    await initParser();
    root = mkdtempSync(join(tmpdir(), "pike-foreign-decl-"));
    writeFileSync(join(root, "header.h"), HEADER_SRC);
    writeFileSync(join(root, "Animal.pike"), ANIMAL_SRC);
    writeFileSync(join(root, "consumer.pike"), CONSUMER_SRC);

    const headerUri = pathToFileURL(join(root, "header.h")).href;
    const animalUri = pathToFileURL(join(root, "Animal.pike")).href;
    consUri = pathToFileURL(join(root, "consumer.pike")).href;

    const index = new WorkspaceIndex({ workspaceRoot: root });
    await index.upsertFile(headerUri, 1, parse(HEADER_SRC), HEADER_SRC, ModificationSource.DidOpen);
    await index.upsertFile(animalUri, 1, parse(ANIMAL_SRC), ANIMAL_SRC, ModificationSource.DidOpen);
    await index.upsertFile(consUri, 1, parse(CONSUMER_SRC), CONSUMER_SRC, ModificationSource.DidOpen);
    // Re-upsert so wiring runs with both targets already indexed.
    await index.upsertFile(consUri, 2, parse(CONSUMER_SRC), CONSUMER_SRC, ModificationSource.DidChange);

    table = index.getSymbolTable(consUri)!;
    wireInheritance(table, index as never);
  });

  afterAll(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("the table really does hold declarations cloned from other files", () => {
    const foreign = table.declarations.filter(d => d.sourceUri && d.sourceUri !== consUri);
    expect(foreign.length).toBeGreaterThan(0);
  });

  test("no position in the file resolves to a declaration written elsewhere", () => {
    const lines = CONSUMER_SRC.split("\n");
    const leaks: string[] = [];
    for (let line = 0; line < lines.length; line++) {
      for (let character = 0; character < lines[line].length; character++) {
        for (const [name, decl] of [
          ["getDefinitionAt", getDefinitionAt(table, line, character)],
          ["getLocalDeclarationAt", getLocalDeclarationAt(table, line, character)],
        ] as const) {
          if (decl && decl.sourceUri && decl.sourceUri !== consUri) {
            leaks.push(
              `${name}(${line},${character}) -> ${decl.kind} ${decl.name} ` +
              `from ${decl.sourceUri.split("/").pop()} @line ${decl.nameRange.start.line}`,
            );
          }
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  test("code lenses and semantic tokens stay inside the document", () => {
    const lineCount = CONSUMER_SRC.split("\n").length;

    const lensLines = produceCodeLenses(table, consUri)
      .map(l => l.range.start.line);
    for (const line of lensLines) expect(line).toBeLessThan(lineCount);

    const tokens = produceSemanticTokens(table);
    const sourceLines = CONSUMER_SRC.split("\n");
    for (const t of tokens) {
      expect(t.line).toBeLessThan(lineCount);
      // The token must cover text that exists on that line.
      expect(t.character + t.length).toBeLessThanOrEqual(sourceLines[t.line].length);
    }
  });

  test("call hierarchy does not anchor an inherited function to this file", () => {
    // `run_around_the_yard` is Animal.pike's, not consumer.pike's — column 7
    // of line 3 is inside its cloned nameRange but is `inherit Animal;` here.
    const enclosing = prepareCallHierarchy(table, consUri, 3, 7);
    for (const item of enclosing) {
      expect(item.uri).toBe(consUri);
      expect(item.range.start.line).toBeLessThan(CONSUMER_SRC.split("\n").length);
    }
  });
});

// ---------------------------------------------------------------------------
// Protocol level: the user-visible CTRL+CLICK bug
// ---------------------------------------------------------------------------

// `do_the_thing` sits at line 3, col 5-17 of module.pmod.
const MODULE_PMOD_SRC = `// TestModule module
int module_counter;
string module_label;
void do_the_thing(int n) {
}
`;

// Padding keeps the header's declaration coordinates overlapping the call site
// in consumer.pike below.
const PAD_HEADER_SRC = `// pad.h
#define PAD_ONE 1
int pad_two;
string pad_three_wide_name(int a) { return "x"; }
int pad_four;
int pad_five;
`;

const PMOD_CONSUMER_SRC = `#include "pad.h"
int main() {
  int local_pad;
  do_the_thing(3);
  return 0;
}
`;

describe("CTRL+CLICK on a module.pmod method (protocol)", () => {
  let server: TestServer;
  let tempRoot: string;
  let modulePmodUri: string;
  let consumerUri: string;

  beforeAll(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "pike-pmod-goto-"));
    const moduleDir = join(tempRoot, "TestModule.pmod");
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(join(moduleDir, "module.pmod"), MODULE_PMOD_SRC);
    writeFileSync(join(moduleDir, "pad.h"), PAD_HEADER_SRC);
    writeFileSync(join(moduleDir, "consumer.pike"), PMOD_CONSUMER_SRC);

    modulePmodUri = pathToFileURL(join(moduleDir, "module.pmod")).href;
    consumerUri = pathToFileURL(join(moduleDir, "consumer.pike")).href;

    server = await createTestServer({ rootUri: pathToFileURL(tempRoot).href });
  });

  afterAll(async () => {
    await server.teardown();
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("resolves to module.pmod, not to an #include'd header", async () => {
    server.openDoc(modulePmodUri, MODULE_PMOD_SRC);
    server.openDoc(consumerUri, PMOD_CONSUMER_SRC);
    await waitForFileEntry(server, [modulePmodUri, consumerUri]);

    // `do_the_thing(3);` — the call is on line 3, columns 2-14. Columns 7-14
    // also fall inside pad.h's `pad_three_wide_name` (line 3, columns 7-26),
    // the coordinates wireIncludes cloned into this file's table.
    const result = await server.client.sendRequest("textDocument/definition", {
      textDocument: { uri: consumerUri },
      position: { line: 3, character: 10 },
    }) as LspLocation | LspLocation[] | null;

    expect(result).not.toBeNull();
    const loc = Array.isArray(result) ? result[0] : result!;
    expect(loc.uri).toBe(modulePmodUri);
    expect(loc.range.start.line).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Cross-file resolution must answer the file a declaration is WRITTEN in
// ---------------------------------------------------------------------------

/**
 * Second root cause, independent of coordinate collisions.
 *
 * Cross-file resolution returned `{ uri: <the file it searched>, decl: <what
 * it found there> }`. When the declaration it found was a clone that file had
 * merged from an `#include`, the URI named one file and the ranges belonged to
 * another — deterministically, every time, no coincidence required.
 */
describe("cross-file targets name the file the declaration is written in", () => {
  let root: string;
  let index: WorkspaceIndex;
  let uris: Record<string, string>;

  const HEADER = "// 0\n// 1\n// 2\n// 3\nvoid do_the_thing(int n) { }\n";
  const MODULE = '#include "header.h"\nint module_local;\n';
  const CONSUMER = "int main() {\n  do_the_thing(3);\n  return 0;\n}\n";

  beforeAll(async () => {
    await initParser();
    root = mkdtempSync(join(tmpdir(), "pike-crossfile-home-"));
    const dir = join(root, "TestModule.pmod");
    mkdirSync(dir, { recursive: true });
    const files: Record<string, string> = {
      "TestModule.pmod/header.h": HEADER,
      "TestModule.pmod/module.pmod": MODULE,
      "TestModule.pmod/consumer.pike": CONSUMER,
    };
    uris = {};
    for (const [rel, src] of Object.entries(files)) {
      writeFileSync(join(root, rel), src);
      uris[rel] = pathToFileURL(join(root, rel)).href;
    }
    index = new WorkspaceIndex({ workspaceRoot: root });
    for (const [rel, src] of Object.entries(files)) {
      await index.upsertFile(uris[rel], 1, parse(src), src, ModificationSource.DidOpen);
    }
    for (const [rel, src] of Object.entries(files)) {
      await index.upsertFile(uris[rel], 2, parse(src), src, ModificationSource.DidChange);
    }
  });

  afterAll(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("a symbol reached through module.pmod resolves to the header that defines it", async () => {
    // `do_the_thing(3);` is line 1, columns 2-14.
    const res = await index.resolveCrossFileDefinition(uris["TestModule.pmod/consumer.pike"], 1, 4);
    expect(res).not.toBeNull();
    expect(res!.uri).toBe(uris["TestModule.pmod/header.h"]);
    expect(res!.decl.nameRange.start.line).toBe(4);
  });

  test("the answered line exists in the answered file", async () => {
    const res = await index.resolveCrossFileDefinition(uris["TestModule.pmod/consumer.pike"], 1, 4);
    const target = res!.uri === uris["TestModule.pmod/header.h"] ? HEADER : MODULE;
    expect(res!.decl.nameRange.start.line).toBeLessThan(target.split("\n").length);
  });
});

// ---------------------------------------------------------------------------
// Runtime-reported target refinement
// ---------------------------------------------------------------------------

/**
 * The Pike runtime answers `resolve()` with a file and a line and no column,
 * and its line is frequently the `{` below a declaration header rather than
 * the header. Refinement pins the real position when the name is genuinely
 * near, and declines when it is not — declining matters, because the caller
 * then offers the top of the file instead of a brace.
 */
describe("refineRuntimeTarget", () => {
  let dir: string;
  let file: string;

  const SRC = [
    "// 0",
    "string translate(string project, string lang)",  // 1
    "  //! doc line",                                  // 2
    "{",                                               // 3  <- what Pike reports
    "  return other->translate(project);",             // 4  member access
    "}",                                               // 5
  ].join("\n") + "\n";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "pike-refine-"));
    file = join(dir, "sample.pike");
    writeFileSync(file, SRC);
  });

  afterAll(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("walks up from the reported brace to the declaration header", async () => {
    const got = await refineRuntimeTarget(file, 3, "translate");
    expect(got).toEqual({ line: 1, character: 7 });
  });

  test("returns the exact column, never 0", async () => {
    const got = await refineRuntimeTarget(file, 1, "translate");
    expect(got!.character).toBe(SRC.split("\n")[1].indexOf("translate"));
  });

  test("declines rather than inventing a position for an absent name", async () => {
    expect(await refineRuntimeTarget(file, 3, "not_in_this_file")).toBeNull();
  });

  test("never answers a member access as if it were the declaration", async () => {
    // Line 4 holds `other->translate(...)`. Anchored there with a radius that
    // cannot reach line 1, the only candidate is the member access.
    const got = await refineRuntimeTarget(file, 5, "translate");
    expect(got === null || got.line !== 4).toBe(true);
  });

  test("an unreadable file yields no target", async () => {
    expect(await refineRuntimeTarget(join(dir, "nope.pike"), 0, "x")).toBeNull();
  });
});
