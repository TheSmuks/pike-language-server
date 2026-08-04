/**
 * Regression: rename must never emit an edit at another file's coordinates.
 *
 * `table.declarations` holds declarations CLONED from #include'd and inherited
 * files, carrying the coordinates they have in THEIR file (the project's
 * standing rule). `getRenameLocations` pushed the declaration edit as
 * `{uri: <open file>, ...decl.nameRange}` with no check that the declaration is
 * written in that file, and then keyed both reference lookups off the same
 * foreign line/column. `getReferencesTo` resolves a position to whatever
 * declaration occupies it, so the whole rename set became a DIFFERENT symbol:
 * the one that happens to sit at that line and column of the open document.
 *
 * The fixture below is built so the two symbols overlap exactly — `int
 * shared_helper` in the header and `int another_value` in the main file both
 * put a 13-character name at line 3, column 4. Renaming `shared_helper`
 * rewrote `another_value` and left `shared_helper` untouched, and because the
 * result still compiles the corruption is silent.
 *
 * Commit b39cd28 added isWrittenInFile()/locate() guards for this class to nine
 * feature files; rename.ts — the only destructive consumer — was not one.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createTestServer, waitForFileEntry, type TestServer } from "./helpers";
import { pikeAvailable } from "../helpers/pikeAvailable";

const PIKE = process.env.PIKE_BINARY ?? "pike";

interface Range { start: { line: number; character: number }; end: { line: number; character: number } }
interface TextEdit { range: Range; newText: string }
interface WorkspaceEdit { changes?: Record<string, TextEdit[]> }

// `shared_helper` sits at 0-based line 2, columns 4-17 of the HEADER.
const HEADER_SRC = `// line 1
// line 2
int shared_helper() { return 7; }
`;

// `another_value` sits at 0-based line 2, columns 4-17 of the MAIN file — the
// same coordinates the header's declaration carries. That collision is what
// turns a foreign coordinate into a silent rewrite of the wrong symbol.
const APP_SRC = `#pragma strict_types
int keep_this = 111;
int another_value = 222;
#include "lib.h"
int main() {
  write("%d\\n", shared_helper() + another_value + keep_this);
  return 0;
}
`;

/** 0-based position of `shared_helper` inside the call on line 5. */
const CALL_LINE = 5;
const CALL_CHAR = 20;

describe("rename never edits at a foreign declaration's coordinates", () => {
  let server: TestServer;
  let root: string;
  let uri: string;
  let app: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "pike-rename-foreign-"));
    app = join(root, "app.pike");
    writeFileSync(join(root, "lib.h"), HEADER_SRC);
    writeFileSync(app, APP_SRC);
    uri = pathToFileURL(app).href;
    server = await createTestServer({ rootUri: pathToFileURL(root).href });
    server.openDoc(uri, APP_SRC);
    await waitForFileEntry(server, [uri], 30000);
  });

  afterAll(async () => {
    await server.teardown();
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test.skipIf(!pikeAvailable)(
    "pike is the oracle: the two symbols are unrelated and the file compiles",
    () => {
      // If they were the same symbol this would not compile with both used.
      const out = execFileSync(PIKE, [app, "-I", root], { encoding: "utf8", cwd: root });
      expect(out.trim()).toBe("340");
    },
  );

  test("renaming an included symbol never rewrites the local symbol at those coordinates", async () => {
    // Cursor on `shared_helper` in `return shared_helper() + ...` (0-based 5:9).
    const edit = await server.client.sendRequest("textDocument/rename", {
      textDocument: { uri }, position: { line: CALL_LINE, character: CALL_CHAR }, newName: "renamed_helper",
    }) as WorkspaceEdit | null;

    const appLines = APP_SRC.split("\n");
    for (const [editUri, edits] of Object.entries(edit?.changes ?? {})) {
      for (const e of edits) {
        if (editUri !== uri) continue;
        const line = appLines[e.range.start.line] ?? "";
        const replaced = line.slice(e.range.start.character, e.range.end.character);
        // The only thing rename may replace in this file is the symbol itself.
        expect(replaced, `edit at ${e.range.start.line}:${e.range.start.character} replaced ${JSON.stringify(replaced)}`)
          .toBe("shared_helper");
        expect(e.range.end.character, "edit must not run past the end of its line")
          .toBeLessThanOrEqual(line.length);
      }
    }
  });

  test("renaming an included symbol leaves another_value alone", async () => {
    const edit = await server.client.sendRequest("textDocument/rename", {
      textDocument: { uri }, position: { line: CALL_LINE, character: CALL_CHAR }, newName: "renamed_helper",
    }) as WorkspaceEdit | null;

    const appLines = APP_SRC.split("\n");
    const touched = (edit?.changes?.[uri] ?? []).map(
      e => (appLines[e.range.start.line] ?? "").slice(e.range.start.character, e.range.end.character),
    );
    expect(touched).not.toContain("another_value");
  });
});
