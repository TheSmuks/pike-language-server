/**
 * Regression: a compiler error raised inside an #include'd file must not be
 * published at that line number of the OPEN document.
 *
 * `normalize_diagnostics` (server/pike/Common.pike) dropped the `file` field
 * the CompilationHandler captures, so the server only ever saw a line number.
 * `buildPikeDiagnostic` then treated it as a line of the open document, with no
 * upper clamp: an error on line 6 of a header appeared on line 6 of a 3-line
 * file — a range past the end of the document, which is not renderable, and
 * when the file was long enough, an error marker on unrelated code.
 *
 * The origin is now carried through and the diagnostic is anchored to the
 * `#include` directive that pulled the file in, with the real file and line in
 * the message.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createTestServer, waitForFileEntry, type TestServer } from "./helpers";
import { pikeAvailable } from "../helpers/pikeAvailable";

interface Range { start: { line: number; character: number }; end: { line: number; character: number } }
interface Diagnostic { range: Range; message: string; source?: string; severity?: number }

// The error sits on line 6 of the header; the includer is only 3 lines long.
const HEADER_SRC = `// 1\n// 2\n// 3\n// 4\n// 5\nint broken() { return "not an int"; }\n`;
const APP_SRC = `#pragma strict_types\n#include "lib.h"\nint main() { return 0; }\n`;

describe("diagnostics from an included file land on the include", () => {
  let server: TestServer;
  let root: string;
  let uri: string;
  const published: Diagnostic[] = [];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "pike-incdiag-"));
    writeFileSync(join(root, "lib.h"), HEADER_SRC);
    const app = join(root, "app.pike");
    writeFileSync(app, APP_SRC);
    uri = pathToFileURL(app).href;
    server = await createTestServer({ rootUri: pathToFileURL(root).href });
    // Diagnostics are pushed, not pulled — this server is push-only by design.
    server.client.onNotification(
      "textDocument/publishDiagnostics",
      (params: { uri: string; diagnostics: Diagnostic[] }) => {
        if (params.uri !== uri) return;
        published.length = 0;
        published.push(...params.diagnostics);
      },
    );
    server.openDoc(uri, APP_SRC);
    await waitForFileEntry(server, [uri], 30000);
  });

  afterAll(async () => {
    await server.teardown();
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  async function diagnostics(): Promise<Diagnostic[]> {
    // Give the compile a chance to land; diagnostics are pushed, not pulled.
    for (let attempt = 0; attempt < 30; attempt++) {
      if (published.some(d => d.source === "pike")) return [...published];
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return [...published];
  }

  test.skipIf(!pikeAvailable)("no diagnostic is placed past the end of the document", async () => {
    const lineCount = APP_SRC.split("\n").length;
    for (const d of await diagnostics()) {
      expect(d.range.start.line, `${d.message} is past the end of a ${lineCount}-line file`)
        .toBeLessThan(lineCount);
      expect(d.range.end.line).toBeLessThan(lineCount);
    }
  });

  test.skipIf(!pikeAvailable)("the header's error is anchored to the #include line", async () => {
    const fromHeader = (await diagnostics()).filter(d => d.message.includes("lib.h"));
    expect(fromHeader.length, "the header's error must still be reported").toBeGreaterThan(0);
    for (const d of fromHeader) {
      // Line 1 (0-based) is `#include "lib.h"`.
      expect(d.range.start.line).toBe(1);
      // And the message must say where it really came from.
      expect(d.message).toMatch(/lib\.h:\d+:/);
    }
  });
});
