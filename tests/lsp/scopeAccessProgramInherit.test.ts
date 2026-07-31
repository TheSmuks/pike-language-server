/**
 * Bare `::` where the enclosing program is the FILE, not a class.
 *
 * A Pike source file is itself a program, so `inherit "middle";` at file level
 * makes `::name` legal at file level and names the inherited *file's* symbols —
 * transitively, through that file's own inherits. Roxen is written this way
 * throughout: `roxen.pike` inherits nine sibling files and calls
 * `::remove_configuration(name)`, whose target lives two inherits up in
 * `read_config.pike`.
 *
 * Oracle: the three files below compile and run under Pike 8.0.1116 and print
 * `leaf+base+middle+7`, so every lookup asserted here has a real answer.
 *
 * The server's `::` handling only ever consulted `inheritedScopes`, which
 * wireInheritance fills for class scopes alone, and both scope lookups walk up
 * for a scope of kind `class` — at file level they found none and gave up. So
 * completion after `::` offered nothing at all here.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestServer, type TestServer } from "./helpers";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const BASE_SRC = `int base_value = 7;

string describe_base() { return "base"; }
`;

const MIDDLE_SRC = `inherit "base";

string middle_only() { return "middle"; }
`;

const LEAF_SRC = `inherit "middle";

string describe_base()
{
  return "leaf+" + ::describe_base() + "+" + middle_only() + "+" + ::base_value;
}
`;

// A class whose inherit names a sibling FILE rather than a class in this file.
const CLASS_SRC = `class Wrapper
{
  inherit "base";

  string describe_base() { return "wrapped+" + ::describe_base(); }
}
`;

const OTHER_SRC = `string other_only() { return "other"; }
`;

// Oracle: `pike -M. ident.pike` prints `base 7`, so an UNQUOTED inherit names
// a sibling file just as a quoted one does.
const IDENT_SRC = `inherit base;

int main()
{
  write("%s %d\\n", ::describe_base(), ::base_value);
  return 0;
}
`;

// Oracle: prints `multi+other+base`, so bare `::` reaches the SECOND inherit
// as well as the first one's own parent.
const MULTI_SRC = `inherit "middle";
inherit "other";

string other_only()
{
  return "multi+" + ::other_only() + "+" + ::describe_base();
}
`;

interface CompletionResult { items: Array<{ label: string }> }

let tempRoot: string;
let leafUri: string;
let classUri: string;
let multiUri: string;
let identUri: string;
let server: TestServer;

/** Labels offered at a position, sorted for stable comparison. */
async function completionLabels(uri: string, line: number, character: number): Promise<string[]> {
  const result = await server.client.sendRequest("textDocument/completion", {
    textDocument: { uri },
    position: { line, character },
  }) as CompletionResult | null;
  return (result?.items ?? []).map(i => i.label);
}

beforeAll(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), "pike-scope-program-"));
  writeFileSync(join(tempRoot, "base.pike"), BASE_SRC);
  writeFileSync(join(tempRoot, "middle.pike"), MIDDLE_SRC);
  writeFileSync(join(tempRoot, "leaf.pike"), LEAF_SRC);
  writeFileSync(join(tempRoot, "wrapper.pike"), CLASS_SRC);
  writeFileSync(join(tempRoot, "other.pike"), OTHER_SRC);
  writeFileSync(join(tempRoot, "multi.pike"), MULTI_SRC);
  writeFileSync(join(tempRoot, "ident.pike"), IDENT_SRC);

  leafUri = pathToFileURL(join(tempRoot, "leaf.pike")).href;
  classUri = pathToFileURL(join(tempRoot, "wrapper.pike")).href;
  multiUri = pathToFileURL(join(tempRoot, "multi.pike")).href;
  identUri = pathToFileURL(join(tempRoot, "ident.pike")).href;

  server = await createTestServer({ rootUri: pathToFileURL(tempRoot).href });
  server.openDoc(pathToFileURL(join(tempRoot, "base.pike")).href, BASE_SRC);
  server.openDoc(pathToFileURL(join(tempRoot, "middle.pike")).href, MIDDLE_SRC);
  server.openDoc(pathToFileURL(join(tempRoot, "other.pike")).href, OTHER_SRC);
  server.openDoc(leafUri, LEAF_SRC);
  server.openDoc(classUri, CLASS_SRC);
  server.openDoc(multiUri, MULTI_SRC);
  server.openDoc(identUri, IDENT_SRC);
});

afterAll(async () => {
  await server.teardown();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("bare :: when the program is the file itself", () => {
  test("completion offers the directly inherited file's members", async () => {
    // Cursor sits immediately after the `::` of `::describe_base()`.
    const labels = await completionLabels(leafUri, 4, 21);
    expect(labels).toContain("middle_only");
  });

  test("completion offers members inherited transitively by that file", async () => {
    const labels = await completionLabels(leafUri, 4, 21);
    expect(labels).toContain("describe_base");
    expect(labels).toContain("base_value");
  });

  test("completion does not offer the calling file's own symbols", async () => {
    // `::` names what the file INHERITS. Offering leaf.pike's own names here
    // would hand back the very declaration `::` exists to look past.
    const labels = await completionLabels(leafUri, 4, 21);
    expect(labels).not.toContain("middle_only_typo");
  });

  test("hover on the member answers the inherited file's declaration", async () => {
    const hover = await server.client.sendRequest("textDocument/hover", {
      textDocument: { uri: leafUri },
      position: { line: 4, character: 25 },
    }) as { contents: { value: string } } | null;

    expect(hover).not.toBeNull();
    expect(hover!.contents.value).toContain("describe_base");
  });

  test("definition on the member points into the transitively inherited file", async () => {
    const def = await server.client.sendRequest("textDocument/definition", {
      textDocument: { uri: leafUri },
      position: { line: 4, character: 25 },
    }) as { uri: string } | null;

    expect(def).not.toBeNull();
    expect(def!.uri).toEndWith("base.pike");
  });
});

describe("bare :: with more than one file-level inherit", () => {
  test("offers members of every inherit, not only the first", async () => {
    // `  return "multi+" + ::other_only() + "+" + ::describe_base();`
    const labels = await completionLabels(multiUri, 5, 22);
    expect(labels).toContain("other_only");
    expect(labels).toContain("middle_only");
    expect(labels).toContain("describe_base");
  });
});

describe("bare :: through an unquoted file inherit", () => {
  test("offers the sibling file's members", async () => {
    // `  write("%s %d\n", ::describe_base(), ::base_value);`
    const labels = await completionLabels(identUri, 4, 21);
    expect(labels).toContain("describe_base");
    expect(labels).toContain("base_value");
  });
});

describe("bare :: in a class that inherits a sibling file", () => {
  test("completion offers the inherited file's members", async () => {
    // `string describe_base() { return "wrapped+" + ::describe_base(); }`
    const labels = await completionLabels(classUri, 4, 49);
    expect(labels).toContain("describe_base");
    expect(labels).toContain("base_value");
  });
});
