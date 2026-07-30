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

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), "roxen-e2e-"));
  mkdirSync(join(workspace, "roxen"), { recursive: true });
  mkdirSync(join(workspace, "app"), { recursive: true });
  writeFileSync(join(workspace, "roxen", "mymodule.pike"), ROXEN_MODULE);
  writeFileSync(join(workspace, "app", "main.pike"), PLAIN_PIKE);

  roxenUri = pathToFileURL(join(workspace, "roxen", "mymodule.pike")).href;
  plainUri = pathToFileURL(join(workspace, "app", "main.pike")).href;

  server = await createTestServer({ rootUri: pathToFileURL(workspace).href });
  server.openDoc(roxenUri, ROXEN_MODULE);
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
