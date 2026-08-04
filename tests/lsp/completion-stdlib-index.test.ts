/**
 * Bundled stdlib index correctness for member completion.
 *
 * The oracle is the real Pike runtime: completion after `Stdio.` must offer
 * what `indices(Stdio)` exposes — including members re-exported from the
 * _Stdio C module (Buffer, Stat, Fd) and sibling-file classes (Readline,
 * Terminfo, FakeFile) — and none of the source-level symbols of
 * Stdio.pmod/module.pmod that are not indexable from outside (protected
 * declarations, #define macros, symbols in inactive #ifdef blocks, and the
 * inherit name itself). Accepting one of those yields uncompilable code:
 * `pike -e 'Stdio.nb_sendfile;'` → "Index 'nb_sendfile' not present".
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createTestServer, waitForIndexed, TestServer } from "./helpers";
import { resetCompletionCache } from "../../server/src/features/completionTrigger";

async function completeAfter(
  server: TestServer,
  uri: string,
  src: string,
  line: number,
  character: number,
): Promise<string[]> {
  const opened = server.openDoc(uri, src);
  await waitForIndexed(server, [opened]);
  const result = (await server.client.sendRequest("textDocument/completion", {
    textDocument: { uri: opened },
    position: { line, character },
  })) as { items: Array<{ label: string }> } | Array<{ label: string }> | null;
  if (!result) return [];
  const items = Array.isArray(result) ? result : result.items;
  return items.map((i) => i.label);
}

describe("stdlib index: module member completion matches the Pike runtime", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer();
    resetCompletionCache();
  });

  afterAll(async () => {
    await server.teardown();
  });

  test("Stdio. offers C-module re-exports and sibling-file classes", async () => {
    const src = ["void f() {", "  Stdio.", "}"].join("\n");
    const labels = await completeAfter(
      server, "file:///test/stdlib-index-stdio.pike", src, 1, 8,
    );

    // From the _Stdio C module, re-exported via `inherit _Stdio;`
    expect(labels).toContain("Buffer");
    expect(labels).toContain("Stat");
    expect(labels).toContain("Fd");
    // Sibling files of Stdio.pmod/
    expect(labels).toContain("Readline");
    expect(labels).toContain("Terminfo");
    expect(labels).toContain("FakeFile");
    // Plain C-module members and constants
    expect(labels).toContain("gethostip");
    expect(labels).toContain("SEEK_SET");
    expect(labels).toContain("SEEK_END");
    // module.pmod's own documented symbols are still there
    expect(labels).toContain("File");
    expect(labels).toContain("read_file");
    expect(labels).toContain("append_path");
  });

  test("a Stdio.File receiver includes inherited runtime methods", async () => {
    const src = ["void f(Stdio.File file) {", "  file->", "}"].join("\n");
    const labels = await completeAfter(
      server, "file:///test/stdlib-index-file.pike", src, 1, 8,
    );
    expect(labels).toContain("write");
    expect(labels).toContain("seek");
  });

  test("Stdio. excludes source-level symbols that are not indexable", async () => {
    const src = ["void f() {", "  Stdio.", "}"].join("\n");
    const labels = await completeAfter(
      server, "file:///test/stdlib-index-stdio-phantoms.pike", src, 1, 8,
    );
    expect(labels.length).toBeGreaterThan(0);

    // protected declarations of module.pmod
    expect(labels).not.toContain("nb_sendfile");
    expect(labels).not.toContain("call_cp_cb");
    expect(labels).not.toContain("open_files");
    // #define macros
    expect(labels).not.toContain("SF_WERR");
    expect(labels).not.toContain("BE_WERR");
    expect(labels).not.toContain("register_open_file");
    expect(labels).not.toContain("register_close_file");
    expect(labels).not.toContain("READER_HALT");
    expect(labels).not.toContain("READER_RESTART");
    // symbols inside an inactive #ifdef TRACK_OPEN_FILES block
    expect(labels).not.toContain("file_open_places");
    expect(labels).not.toContain("next_open_file_id");
    expect(labels).not.toContain("registering_files");
    expect(labels).not.toContain("report_file_open_places");
    // the inherit name itself is not an index of the module
    expect(labels).not.toContain("_Stdio");
  });

  test("String. keeps its runtime members without leaking internals", async () => {
    const src = ["void f() {", "  String.", "}"].join("\n");
    const labels = await completeAfter(
      server, "file:///test/stdlib-index-string.pike", src, 1, 9,
    );

    expect(labels).toContain("Buffer");
    expect(labels).toContain("trim_all_whites");
    expect(labels).toContain("count");
  });

  test("Protocols.HTTP. resolves the nested module path", async () => {
    const src = ["void f() {", "  Protocols.HTTP.", "}"].join("\n");
    const labels = await completeAfter(
      server, "file:///test/stdlib-index-protocols-http.pike", src, 1, 17,
    );

    expect(labels).toContain("get_url");
    expect(labels).toContain("post_url");
    expect(labels).toContain("HTTP_OK");
    expect(labels).toContain("Session");
  });

  test("Yp. (unreconciled on this host) offers filtered source symbols only", async () => {
    // Yp resolves with empty indices() here because the NIS C core is absent,
    // so the generator leaves it unreconciled (no `reconciled.Yp` marker) and
    // completion falls back to parsing the installed Yp.pmod source. That
    // fallback must still apply the indexability filter: the module's public
    // declarations are offered, the `inherit .___Yp;` name is not — and the
    // harvested entries must not have been wiped by the reconciler.
    const src = ["void f() {", "  Yp.", "}"].join("\n");
    const labels = await completeAfter(
      server, "file:///test/stdlib-index-yp.pike", src, 1, 5,
    );

    expect(labels).toContain("Map");
    expect(labels).toContain("nicknames");
    expect(labels).not.toContain("___Yp");
  });

  test("Array. offers runtime members", async () => {
    const src = ["void f() {", "  Array.", "}"].join("\n");
    const labels = await completeAfter(
      server, "file:///test/stdlib-index-array.pike", src, 1, 8,
    );

    expect(labels).toContain("uniq");
    expect(labels).toContain("flatten");
    expect(labels).toContain("sum");
  });
});

describe("workspace module member completion applies Pike's visibility rule", () => {
  let server: TestServer;
  let tempRoot: string;

  // Verified against `pike -M`: indices(MyLib) is exactly the four public
  // names; MyLib.prot_fn / priv_fn / ProtClass / PrivClass / prot_var /
  // priv_var each fail with "Index ... not present in module MyLib".
  const MODULE_SRC = [
    "int pub_var = 1;",
    "constant PUB_CONST = 2;",
    "int pub_fn() { return 3; }",
    "class PubClass {}",
    "protected int prot_var = 4;",
    "private int priv_var = 5;",
    "protected int prot_fn() { return 6; }",
    "private int priv_fn() { return 7; }",
    "protected class ProtClass {}",
    "private class PrivClass {}",
    "",
  ].join("\n");

  // Verified against `pike -M`: indices(BlkLib) is exactly ({"pub2"});
  // BlkLib.blk_var / blk_fn / BlkClass are each rejected.
  const BLOCK_SRC = [
    "private {",
    "  int blk_var;",
    "  int blk_fn() { return 1; }",
    "  class BlkClass {}",
    "}",
    "int pub2;",
    "",
  ].join("\n");

  beforeAll(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "pike-lsp-vistest-"));
    writeFileSync(join(tempRoot, "MyLib.pmod"), MODULE_SRC);
    writeFileSync(join(tempRoot, "BlkLib.pmod"), BLOCK_SRC);
    server = await createTestServer({ rootUri: pathToFileURL(tempRoot).href });
    resetCompletionCache();
  });

  afterAll(async () => {
    await server.teardown();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("MyLib. offers only what indices(MyLib) exposes", async () => {
    const src = ["void f() {", "  MyLib.", "}"].join("\n");
    const uri = pathToFileURL(join(tempRoot, "consumer.pike")).href;
    const labels = await completeAfter(server, uri, src, 1, 8);

    expect(labels).toContain("pub_var");
    expect(labels).toContain("PUB_CONST");
    expect(labels).toContain("pub_fn");
    expect(labels).toContain("PubClass");

    expect(labels).not.toContain("prot_var");
    expect(labels).not.toContain("priv_var");
    expect(labels).not.toContain("prot_fn");
    expect(labels).not.toContain("priv_fn");
    expect(labels).not.toContain("ProtClass");
    expect(labels).not.toContain("PrivClass");
  });

  test("a `private { … }` modifier block hides everything it wraps", async () => {
    const src = ["void f() {", "  BlkLib.", "}"].join("\n");
    const uri = pathToFileURL(join(tempRoot, "consumer-blk.pike")).href;
    const labels = await completeAfter(server, uri, src, 1, 9);

    expect(labels).toContain("pub2");
    expect(labels).not.toContain("blk_var");
    expect(labels).not.toContain("blk_fn");
    expect(labels).not.toContain("BlkClass");
  });
});
