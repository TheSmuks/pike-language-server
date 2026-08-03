/**
 * Regression: rename must never hand back an edit that breaks the file.
 *
 * Both defects below were proven with the pike binary, not by inspection:
 * applying the server's own edits turned a running program into one that
 * fails to run at all.
 *
 *  - `this`, `this_object()` and `this_program` bind to the enclosing class so
 *    that go-to-definition on them lands there. That is correct and must stay
 *    correct. They are not written occurrences of the class NAME, though, and
 *    rename rewrote all three: `return this;` became `return Maker;`, which
 *    returns the program instead of the instance.
 *  - `#include "foo.pike"` was offered as renameable, with the quoted path as
 *    the placeholder. Accepting it produced `#include newname`, which Pike
 *    rejects outright.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createTestServer, waitForFileEntry, type TestServer } from "./helpers";
import { pikeAvailable } from "../helpers/pikeAvailable";

/** Honour PIKE_BINARY the way the rest of the suite does. */
const PIKE = process.env.PIKE_BINARY ?? "pike";

interface Range { start: { line: number; character: number }; end: { line: number; character: number } }
interface TextEdit { range: Range; newText: string }
interface WorkspaceEdit { changes?: Record<string, TextEdit[]> }
interface Location { uri: string; range: Range }

// Same shape as corpus/files/class-this-object.pike: a fluent builder that
// depends on `this` returning the instance.
const BUILDER_SRC = `class Builder {
  string buf = "";

  Builder add(string s) {
    buf += s;
    return this;
  }

  string build() {
    return buf;
  }

  object self_ref() {
    return this_object();
  }

  string own_type() {
    return sprintf("%O", this_program);
  }
}

int main() {
  Builder b = Builder();
  string result = b->add("hello")->add(" ")->add("world")->build();
  write("result = %s\\n", result);
  write("self_ref same? %d\\n", b == b->self_ref());
  return 0;
}
`;

/** Apply edits last-first so earlier offsets stay valid. */
function applyEdits(src: string, edits: TextEdit[]): string {
  const lines = src.split("\n");
  const ordered = [...edits].sort(
    (a, b) => b.range.start.line - a.range.start.line ||
      b.range.start.character - a.range.start.character,
  );
  for (const e of ordered) {
    const l = lines[e.range.start.line];
    lines[e.range.start.line] =
      l.slice(0, e.range.start.character) + e.newText + l.slice(e.range.end.character);
  }
  return lines.join("\n");
}

describe("rename does not rewrite this / this_object() / this_program", () => {
  let server: TestServer;
  let root: string;
  let uri: string;
  let file: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "pike-rename-corrupt-"));
    file = join(root, "builder.pike");
    writeFileSync(file, BUILDER_SRC);
    uri = pathToFileURL(file).href;
    server = await createTestServer({ rootUri: pathToFileURL(root).href });
    server.openDoc(uri, BUILDER_SRC);
    await waitForFileEntry(server, [uri], 30000);
  });

  afterAll(async () => {
    await server.teardown();
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("every rename edit lands on the identifier being renamed", async () => {
    // `class Builder {` is line 0, Builder at columns 6-13.
    const edit = await server.client.sendRequest("textDocument/rename", {
      textDocument: { uri }, position: { line: 0, character: 9 }, newName: "Maker",
    }) as WorkspaceEdit;

    const edits = edit.changes?.[uri] ?? [];
    expect(edits.length).toBeGreaterThan(0);
    const lines = BUILDER_SRC.split("\n");
    for (const e of edits) {
      const replaced = lines[e.range.start.line]
        .slice(e.range.start.character, e.range.end.character);
      expect(replaced).toBe("Builder");
    }
  });

  test("documentHighlight paints only written occurrences of the name", async () => {
    const highlights = await server.client.sendRequest("textDocument/documentHighlight", {
      textDocument: { uri }, position: { line: 0, character: 9 },
    }) as Array<{ range: Range }>;

    const lines = BUILDER_SRC.split("\n");
    for (const h of highlights) {
      const text = lines[h.range.start.line]
        .slice(h.range.start.character, h.range.end.character);
      expect(text).toBe("Builder");
    }
  });

  test("go-to-definition on this / this_object() / this_program still finds the class", async () => {
    const lines = BUILDER_SRC.split("\n");
    const probes: Array<[string, number]> = [
      ["this", 5], ["this_object()", 13], ["this_program", 17],
    ];
    for (const [name, line] of probes) {
      const col = lines[line].indexOf(name);
      expect(col).toBeGreaterThanOrEqual(0);
      const res = await server.client.sendRequest("textDocument/definition", {
        textDocument: { uri }, position: { line, character: col + 2 },
      }) as Location | Location[] | null;
      const first = Array.isArray(res) ? res[0] : res;
      expect(first, `definition on ${name}`).not.toBeNull();
      expect(lines[first!.range.start.line]).toContain("class Builder");
    }
  });

  test.skipIf(!pikeAvailable)(
    "the renamed program still runs — pike is the oracle",
    () => {
      // Guard the guard: the fixture must run BEFORE any rename.
      const before = execFileSync(PIKE, [file], { encoding: "utf8" });
      expect(before).toContain("result = hello world");
      expect(before).toContain("self_ref same? 1");
    },
  );

  test.skipIf(!pikeAvailable)(
    "applying the server's rename edits keeps the program running",
    async () => {
      const edit = await server.client.sendRequest("textDocument/rename", {
        textDocument: { uri }, position: { line: 0, character: 9 }, newName: "Maker",
      }) as WorkspaceEdit;
      const renamedSrc = applyEdits(BUILDER_SRC, edit.changes?.[uri] ?? []);
      expect(renamedSrc).toContain("return this;");
      expect(renamedSrc).toContain("return this_object();");

      const renamedPath = join(root, "renamed.pike");
      writeFileSync(renamedPath, renamedSrc);
      const out = execFileSync(PIKE, [renamedPath], { encoding: "utf8" });
      expect(out).toContain("result = hello world");
      expect(out).toContain("self_ref same? 1");
    },
  );
});

describe("an #include path is not a renameable symbol", () => {
  let server: TestServer;
  let root: string;
  let uri: string;

  const SRC = `#include "nonexistent.pike"

int main() {
  return 0;
}
`;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "pike-rename-include-"));
    const file = join(root, "inc.pike");
    writeFileSync(file, SRC);
    uri = pathToFileURL(file).href;
    server = await createTestServer({ rootUri: pathToFileURL(root).href });
    server.openDoc(uri, SRC);
    await waitForFileEntry(server, [uri], 30000);
  });

  afterAll(async () => {
    await server.teardown();
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("prepareRename declines inside the quoted path", async () => {
    const res = await server.client.sendRequest("textDocument/prepareRename", {
      textDocument: { uri }, position: { line: 0, character: 12 },
    });
    expect(res).toBeNull();
  });

  test("rename produces no edits even when prepareRename is skipped", async () => {
    // A client is free to send rename without ever calling prepareRename, and
    // that request is the destructive one.
    let edits: TextEdit[] = [];
    try {
      const res = await server.client.sendRequest("textDocument/rename", {
        textDocument: { uri }, position: { line: 0, character: 12 }, newName: "newname",
      }) as WorkspaceEdit | null;
      edits = Object.values(res?.changes ?? {}).flat();
    } catch {
      // Rejecting the request outright is also a correct refusal.
      edits = [];
    }
    expect(edits).toEqual([]);
  });
});
