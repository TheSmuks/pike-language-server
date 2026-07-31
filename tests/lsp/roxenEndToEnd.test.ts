/**
 * End-to-end Roxen behaviour through the real LSP.
 *
 * These drive the server the way an editor does, because the unit tests for
 * detection, activation, and the index each passed while the wiring between
 * them was still wrong: hover rendered only a provenance line, because the
 * handler claimed its documentation already contained the signature. Nothing
 * below a full request would have caught that.
 *
 * Roxen is not installed on most machines, and it deliberately is not required
 * here — this is the no-installation path the bundled index exists for.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createTestServer, type TestServer } from "./helpers";

interface HoverResult {
  contents: { kind: string; value: string };
}

interface CompletionResult {
  items: { label: string; detail?: string }[];
}

const ROXEN_MODULE = `#include <module.h>
inherit "module";

constant module_type = MODULE_LOCATION;
constant module_name = "Test filesystem";

int flags = TYPE_STRING;
`;

/**
 * The surface Roxen never documents.
 *
 * `cvs_version` is declared by each module rather than by the prototype;
 * `defvar` is on the prototype but carries no `//!`; `report_fatal` is a global
 * roxenloader injects at run time. All three are things Roxen code writes
 * constantly and none of them came out of Pike's AutoDoc extractor.
 */
const ROXEN_UNDOCUMENTED = `#include <module.h>
inherit "module";

constant module_type = MODULE_LOCATION;

void create()
{
  defvar("mountpoint", "/", "Mount point", TYPE_STRING);
}

void probe(RoxenModule other)
{
  string version = other->cvs_version;
  string dir = roxen_path("$VARDIR/state");
  predef::report_fatal("boom %O %O\\n", version, dir);
}
`;

const PLAIN_PIKE = `int main()
{
  int flags = 1;
  write("plain\\n");
  return 0;
}
`;

let workspace: string;
let server: TestServer;
let roxenUri: string;
let plainUri: string;
let undocumentedUri: string;

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), "roxen-e2e-"));
  mkdirSync(join(workspace, "roxen"), { recursive: true });
  mkdirSync(join(workspace, "app"), { recursive: true });
  writeFileSync(join(workspace, "roxen", "mymodule.pike"), ROXEN_MODULE);
  writeFileSync(join(workspace, "roxen", "undocumented.pike"), ROXEN_UNDOCUMENTED);
  writeFileSync(join(workspace, "app", "main.pike"), PLAIN_PIKE);

  roxenUri = pathToFileURL(join(workspace, "roxen", "mymodule.pike")).href;
  undocumentedUri = pathToFileURL(join(workspace, "roxen", "undocumented.pike")).href;
  plainUri = pathToFileURL(join(workspace, "app", "main.pike")).href;

  server = await createTestServer({ rootUri: pathToFileURL(workspace).href });
  server.openDoc(roxenUri, ROXEN_MODULE);
  server.openDoc(undocumentedUri, ROXEN_UNDOCUMENTED);
  server.openDoc(plainUri, PLAIN_PIKE);
  // didOpen is a notification; give the server a turn to index both documents.
  await new Promise((resolve) => setTimeout(resolve, 500));
});

afterAll(async () => {
  await server?.teardown();
  rmSync(workspace, { recursive: true, force: true });
});

/** Hover at the first occurrence of `needle` in `text`. */
function positionOf(text: string, needle: string): { line: number; character: number } {
  const lines = text.split("\n");
  for (let line = 0; line < lines.length; line++) {
    const character = lines[line]!.indexOf(needle);
    if (character >= 0) return { line, character: character + 1 };
  }
  throw new Error(`${needle} not present in the fixture`);
}

describe("hover on a dotted Roxen symbol", () => {
  /**
   * `RXML.` and `Roxen.` are 446 of the index's 719 symbols, and they are only
   * ever written dotted. Bare-name lookup cannot reach them: the cursor sits on
   * `Tag`, and `Tag` alone means nothing — the entry is keyed `RXML.Tag`.
   */
  test("resolves a dotted API symbol in expression position", async () => {
    const src = `#include <module.h>
inherit "module";

constant module_type = MODULE_LOCATION;

mixed truth() { return Roxen.True; }
`;
    const uri = server.openDoc("file:///test/roxen-dotted.pike", src);
    const hover = await server.client.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position: positionOf(src, "True"),
    }) as HoverResult | null;

    expect(hover).not.toBeNull();
    expect(hover!.contents.value).toContain("bundled index");
  });

  /**
   * The audit's own case: `constant store = roxen.store;` in Roxen's
   * configuration.pike, which returned null. `roxen` is the object roxenloader
   * binds to roxen.pike; the index carried the global and none of its members.
   */
  test("resolves a member of the roxen global object", async () => {
    const src = `#include <module.h>
inherit "module";

constant module_type = MODULE_LOCATION;
constant store = roxen.store;
`;
    const uri = server.openDoc("file:///test/roxen-global-member.pike", src);
    const hover = await server.client.sendRequest("textDocument/hover", {
      textDocument: { uri },
      // The second `store` on the line — the one after the dot.
      position: { line: 4, character: src.split("\n")[4]!.lastIndexOf("store") + 1 },
    }) as HoverResult | null;

    expect(hover).not.toBeNull();
    expect(hover!.contents.value).toContain("store(");
    // roxen.pike does not declare `store`; it is four inherits down the chain,
    // and the entry says which file so the reader can go and read it.
    expect(hover!.contents.value).toContain("read_config.pike");
    expect(hover!.contents.value).toContain("bundled index");
  });

  test("resolves a member of the roxenloader global object", async () => {
    const src = `#include <module.h>
inherit "module";

constant module_type = MODULE_LOCATION;
string where() { return roxenloader.server_dir; }
`;
    const uri = server.openDoc("file:///test/roxenloader-member.pike", src);
    const hover = await server.client.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position: positionOf(src, "server_dir"),
    }) as HoverResult | null;

    expect(hover).not.toBeNull();
    expect(hover!.contents.value).toContain("server_dir");
    expect(hover!.contents.value).toContain("bundled index");
  });

  /**
   * `roxen.query` is the server object's `query`; the bare `query` a module
   * writes is the module prototype's. The dotted tier has to beat the bare one
   * or this answers with the wrong declaration rather than with none.
   */
  test("prefers the qualified member over a bare name of the same spelling", async () => {
    const src = `#include <module.h>
inherit "module";

constant module_type = MODULE_LOCATION;
mixed salt() { return roxen.query("server_salt"); }
`;
    const uri = server.openDoc("file:///test/roxen-shadowed-member.pike", src);
    const qualified = await server.client.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position: positionOf(src, "query"),
    }) as HoverResult | null;

    expect(qualified).not.toBeNull();
    expect(qualified!.contents.value).toContain("Member of `roxen`");
  });

  test("offers nothing dotted in a plain Pike file", async () => {
    const src = "mixed truth() { return Roxen.True; }\n";
    const uri = server.openDoc("file:///test/plain-dotted.pike", src);
    const hover = await server.client.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position: positionOf(src, "True"),
    }) as HoverResult | null;

    expect(hover === null || !hover.contents.value.includes("bundled index")).toBe(true);
  });

  test("offers no member of a Roxen global in a plain Pike file", async () => {
    // `roxen` is a perfectly ordinary variable name outside Roxen.
    const src = "mixed f(mapping roxen) { return roxen.store; }\n";
    const uri = server.openDoc("file:///test/plain-global-member.pike", src);
    const hover = await server.client.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position: { line: 0, character: src.lastIndexOf("store") + 1 },
    }) as HoverResult | null;

    expect(hover === null || !hover.contents.value.includes("bundled index")).toBe(true);
  });
});

describe("hover in a Roxen file without an installation", () => {
  test("renders the declaration, not just its provenance", async () => {
    const hover = await server.client.sendRequest("textDocument/hover", {
      textDocument: { uri: roxenUri },
      position: positionOf(ROXEN_MODULE, "MODULE_LOCATION"),
    }) as HoverResult | null;

    expect(hover).not.toBeNull();
    // The regression this file exists for: the signature must survive.
    expect(hover!.contents.value).toContain("MODULE_LOCATION");
    expect(hover!.contents.value).toContain("```pike");
    // And it must say where the answer came from, since go-to-definition
    // cannot follow it anywhere.
    expect(hover!.contents.value).toContain("bundled index");
  });

  test("resolves a constant from a different Roxen header", async () => {
    const hover = await server.client.sendRequest("textDocument/hover", {
      textDocument: { uri: roxenUri },
      position: positionOf(ROXEN_MODULE, "TYPE_STRING"),
    }) as HoverResult | null;

    expect(hover).not.toBeNull();
    expect(hover!.contents.value).toContain("TYPE_STRING");
    expect(hover!.contents.value).toContain("module.h");
  });
});

describe("hover on the surface Roxen leaves undocumented", () => {
  test("resolves a member modules supply by convention", async () => {
    // `RoxenModule me; … me->cvs_version` is what Roxen's own configuration.pike
    // writes. No prototype declares cvs_version, so nothing but the corpus
    // measurement in the generator puts it within reach.
    const hover = await server.client.sendRequest("textDocument/hover", {
      textDocument: { uri: undocumentedUri },
      position: positionOf(ROXEN_UNDOCUMENTED, "cvs_version"),
    }) as HoverResult | null;

    expect(hover).not.toBeNull();
    expect(hover!.contents.value).toContain("cvs_version");
    expect(hover!.contents.value).toContain("bundled index");
  });

  test("resolves a global Roxen's startup injects and nothing else declares", async () => {
    // roxen_path exists only because roxenloader add_constant()s it; no header
    // defines it and no prototype declares it, so before it was harvested this
    // request had nothing to answer with. The note says "Roxen's startup", not
    // "roxenloader": other files inject too (`chroot` from the master,
    // `get_font` from fonts.pike), so crediting the loader was inaccurate.
    const hover = await server.client.sendRequest("textDocument/hover", {
      textDocument: { uri: undocumentedUri },
      position: positionOf(ROXEN_UNDOCUMENTED, "roxen_path"),
    }) as HoverResult | null;

    expect(hover).not.toBeNull();
    expect(hover!.contents.value).toContain("roxen_path");
    expect(hover!.contents.value).toContain("Injected into Pike's namespace");
    expect(hover!.contents.value).toContain("bundled index");
  });

  test("answers predef::report_fatal, which used to return nothing", async () => {
    const hover = await server.client.sendRequest("textDocument/hover", {
      textDocument: { uri: undocumentedUri },
      position: positionOf(ROXEN_UNDOCUMENTED, "report_fatal"),
    }) as HoverResult | null;

    expect(hover).not.toBeNull();
    // The module prototype wraps the injected global under the same name and
    // shadows it, which is what Pike resolution does too — either declaration
    // is a truthful answer, and both were absent from the index before.
    expect(hover!.contents.value).toContain("report_fatal");
    expect(hover!.contents.value).toContain("sprintf_format");
    expect(hover!.contents.value).toContain("bundled index");
  });

  test("resolves an undocumented prototype member", async () => {
    // Every module calls defvar in create(); the prototype declares it with no
    // `//!` at all, so AutoDoc never saw it.
    const hover = await server.client.sendRequest("textDocument/hover", {
      textDocument: { uri: undocumentedUri },
      position: positionOf(ROXEN_UNDOCUMENTED, "defvar"),
    }) as HoverResult | null;

    expect(hover).not.toBeNull();
    expect(hover!.contents.value).toContain("defvar");
    expect(hover!.contents.value).toContain("bundled index");
  });
});

describe("completion of roxenloader's injected globals", () => {
  test("offers them after predef::, which is how a Roxen file writes them", async () => {
    const line = ROXEN_UNDOCUMENTED.split("\n")
      .findIndex((l) => l.includes("predef::report_fatal"));
    const character = ROXEN_UNDOCUMENTED.split("\n")[line]!.indexOf("predef::") + "predef::".length;

    const result = await server.client.sendRequest("textDocument/completion", {
      textDocument: { uri: undocumentedUri },
      position: { line, character },
    }) as CompletionResult;

    const labels = new Set(result.items.map((i) => i.label));
    expect(labels.has("report_fatal")).toBe(true);
    // Pike's own predefined names must still be there: the Roxen globals are
    // added to that namespace, not substituted for it.
    expect(labels.has("sprintf")).toBe(true);
  });

  test("offers them bare, because roxenloader put them in predef", async () => {
    const result = await server.client.sendRequest("textDocument/completion", {
      textDocument: { uri: undocumentedUri },
      position: positionOf(ROXEN_UNDOCUMENTED, "report_fatal"),
    }) as CompletionResult;

    expect(new Set(result.items.map((i) => i.label)).has("report_fatal")).toBe(true);
  });

  test("offers none of them in a plain Pike file", async () => {
    const result = await server.client.sendRequest("textDocument/completion", {
      textDocument: { uri: plainUri },
      position: positionOf(PLAIN_PIKE, "flags"),
    }) as CompletionResult;

    const labels = new Set(result.items.map((i) => i.label));
    expect(labels.has("report_fatal")).toBe(false);
    expect(labels.has("cvs_version")).toBe(false);
  });
});

describe("hover in a plain Pike file", () => {
  test("offers no Roxen answer for an unknown identifier", async () => {
    const hover = await server.client.sendRequest("textDocument/hover", {
      textDocument: { uri: plainUri },
      position: positionOf(PLAIN_PIKE, "flags"),
    }) as HoverResult | null;

    // It may hover as a local `int flags`, but it must never claim to be Roxen.
    if (hover) expect(hover.contents.value).not.toContain("bundled index");
  });
});

describe("completion", () => {
  test("offers Roxen constants in a Roxen file", async () => {
    const result = await server.client.sendRequest("textDocument/completion", {
      textDocument: { uri: roxenUri },
      // Inside the `TYPE_STRING` token, so the request is an unqualified
      // identifier completion rather than a statement-start with no prefix.
      position: positionOf(ROXEN_MODULE, "TYPE_STRING"),
    }) as CompletionResult;

    const labels = new Set(result.items.map((i) => i.label));
    expect(labels.has("MODULE_LOCATION")).toBe(true);
    expect(labels.has("TYPE_STRING")).toBe(true);
  });

  test("offers no Roxen symbol in a plain Pike file in the same workspace", async () => {
    const result = await server.client.sendRequest("textDocument/completion", {
      textDocument: { uri: plainUri },
      position: positionOf(PLAIN_PIKE, "flags"),
    }) as CompletionResult;

    const labels = new Set(result.items.map((i) => i.label));
    expect(labels.has("MODULE_LOCATION")).toBe(false);
    expect(labels.has("TYPE_STRING")).toBe(false);
  });
});

describe("go-to-definition on an index-only symbol", () => {
  test("returns nothing rather than a fabricated location", async () => {
    const result = await server.client.sendRequest("textDocument/definition", {
      textDocument: { uri: roxenUri },
      position: positionOf(ROXEN_MODULE, "MODULE_LOCATION"),
    }) as unknown;

    // With no installation there is no real file to open, and inventing one
    // would send the user to a path that does not exist on their machine.
    const empty = result === null || (Array.isArray(result) && result.length === 0);
    expect(empty).toBe(true);
  });
});
