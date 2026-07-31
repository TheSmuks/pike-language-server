/**
 * Hover on `::member` must describe the inherited member, not a same-named
 * local one.
 *
 * This pins the case hover DOES get right — an inherit naming a workspace
 * file. It is a regression guard, not a reproduction: the known defect is
 * narrower than it first looked.
 *
 * Still open, deliberately not asserted here because no fix is in place:
 * when the inherit names a *stdlib or index-only* class, hover has no tier for
 * it and answers from a name-only lookup instead. `fsgc.pike:163` is the live
 * example — `class Monitor { inherit basic::Monitor; }`, where `basic::Monitor`
 * is `Filesystem.Monitor.basic.Monitor`; hover reports `void create()` while
 * both the inherited member and the local one take arguments. Completion at
 * that same position is correct, because it grew a four-tier chain (workspace
 * file, same-file class, stdlib index, worker runtime resolve) that hover
 * never got.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createTestServer, type TestServer } from "./helpers";

interface HoverResult { contents: { value: string } }

let server: TestServer;
let root: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "pike-scope-hover-"));

  writeFileSync(
    join(root, "base.pike"),
    "void configure(string path, int flags) { }\n",
    "utf8",
  );
  // A same-named member on the caller, with a different signature. A name-only
  // lookup finds this one; `::configure` must not.
  writeFileSync(
    join(root, "leaf.pike"),
    'inherit "base.pike";\n\nvoid configure() { }\n\nvoid go() { ::configure("/", 1); }\n',
    "utf8",
  );

  server = await createTestServer({ rootUri: pathToFileURL(root).href });
});

afterAll(async () => {
  await server.teardown();
});

describe("hover on a :: member", () => {
  test("describes the inherited member, not the same-named local one", async () => {
    const uri = pathToFileURL(join(root, "leaf.pike")).href;
    server.openDoc(uri, 'inherit "base.pike";\n\nvoid configure() { }\n\nvoid go() { ::configure("/", 1); }\n');

    // `configure` in `::configure("/", 1)` on line 4.
    const hover = await server.client.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position: { line: 4, character: 16 },
    }) as HoverResult | null;

    expect(hover).not.toBeNull();
    // The inherited one takes two parameters; the local one takes none.
    expect(hover!.contents.value).toContain("string path");
  });
});
