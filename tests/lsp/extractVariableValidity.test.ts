/**
 * Regression: an offered "Extract to variable" must produce compilable Pike.
 *
 * `validateExtractSelection` was purely textual — it rejected multi-line
 * selections, empty ones, selections ending in `;`, and bare identifiers, and
 * nothing else. So selecting a declaration emitted
 * `mixed extracted = int x = 1;`, and selecting `1, 2` from an argument list
 * emitted `mixed extracted = 1, 2;`. Pike rejects both, from a refactoring the
 * user accepted.
 *
 * Rather than enumerate what an expression is not, the action now parses the
 * declaration it would write and declines when that does not parse.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractVariable } from "../../server/src/features/codeActionSourceActions";
import { initParser } from "../../server/src/parser";
import { pikeAvailable } from "../helpers/pikeAvailable";

const PIKE = process.env.PIKE_BINARY ?? "pike";

interface Range { start: { line: number; character: number }; end: { line: number; character: number } }
interface TextEdit { range: Range; newText: string }

beforeAll(async () => {
  await initParser();
});

/** Ask for the refactoring over a single-line selection. */
function extract(src: string, line: number, startChar: number, endChar: number) {
  return extractVariable(
    {
      textDocument: { uri: "file:///probe.pike" },
      range: { start: { line, character: startChar }, end: { line, character: endChar } },
      context: { diagnostics: [] },
    } as never,
    src,
  );
}

/** Apply edits last-first so earlier offsets stay valid. */
function applyEdits(src: string, edits: TextEdit[]): string {
  const lines = src.split("\n");
  const ordered = [...edits].sort(
    (a, b) => b.range.start.line - a.range.start.line ||
      b.range.start.character - a.range.start.character,
  );
  for (const e of ordered) {
    const head = lines[e.range.start.line].slice(0, e.range.start.character);
    const tail = lines[e.range.end.line].slice(e.range.end.character);
    lines.splice(
      e.range.start.line,
      e.range.end.line - e.range.start.line + 1,
      head + e.newText + tail,
    );
  }
  return lines.join("\n");
}

function compileError(src: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), "pike-extract-"));
  const file = join(dir, "probe.pike");
  writeFileSync(file, src);
  try {
    execFileSync(PIKE, ["-e", `compile_file("${file}");`], { encoding: "utf8", stdio: "pipe" });
    return null;
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string };
    return (e.stderr ?? "") + (e.stdout ?? "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const DECLARATION_SRC = `int main() {\n  int x = 1;\n  return x;\n}\n`;
const COMMA_SRC = `int add(int a, int b) { return a + b; }\nint main() {\n  int r = add(1, 2);\n  return r;\n}\n`;
const EXPRESSION_SRC = `int main() {\n  int r = 1 + 2 * 3;\n  return r;\n}\n`;

describe("extract to variable only offers what compiles", () => {
  test("a declaration selection is declined", () => {
    // Selecting `int x = 1` — not an expression.
    expect(extract(DECLARATION_SRC, 1, 2, 11)).toBeNull();
  });

  test("a comma-separated argument selection is declined", () => {
    // Selecting `1, 2` from `add(1, 2)`.
    expect(extract(COMMA_SRC, 2, 14, 18)).toBeNull();
  });

  test("a real expression is still offered", () => {
    const result = extract(EXPRESSION_SRC, 1, 10, 19);
    expect(result, "guard the guard: a valid expression must still be extractable")
      .not.toBeNull();
    expect(result!.edits.length).toBe(2);
  });

  test.skipIf(!pikeAvailable)("pike is the oracle: anything offered still compiles", () => {
    for (const [label, src, line, sc, ec] of [
      ["declaration", DECLARATION_SRC, 1, 2, 11],
      ["comma list", COMMA_SRC, 2, 14, 18],
      ["expression", EXPRESSION_SRC, 1, 10, 19],
    ] as const) {
      // Guard the guard: every fixture compiles before the refactoring.
      expect(compileError(src), `${label}: fixture must compile first`).toBeNull();

      const result = extract(src, line, sc, ec);
      if (!result) continue; // declined — nothing to check
      const applied = applyEdits(src, result.edits);
      expect(compileError(applied), `${label}: offered refactoring produced\n${applied}`)
        .toBeNull();
    }
  });
});
