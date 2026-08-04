/**
 * Regression: "Organize imports" must move only import lines.
 *
 * The producer emitted ONE edit replacing everything from the first import line
 * to the last with the sorted import list. Any line that happened to sit
 * between two imports was destroyed — an `inherit` clause, a comment, a blank
 * line. Losing an inherit makes the file stop compiling, from a source action
 * whose entire remit is reordering imports.
 *
 * The pike binary is the oracle: the fixture compiles before the action, and
 * must still compile after it.
 */

import { describe, test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { organizeImports } from "../../server/src/features/codeActionSourceActions";
import { pikeAvailable } from "../helpers/pikeAvailable";

const PIKE = process.env.PIKE_BINARY ?? "pike";

interface Range { start: { line: number; character: number }; end: { line: number; character: number } }
interface TextEdit { range: Range; newText: string }

const BASE_LIB = `int helper_value() { return 42; }\n`;

const SRC = `#pragma strict_types
import Stdio;
inherit "base-lib.pike";
// keep this comment
import Array;

int main() {
  return helper_value();
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

/** Compile in a directory that also holds base-lib.pike. */
function compileError(src: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), "pike-oi-"));
  writeFileSync(join(dir, "base-lib.pike"), BASE_LIB);
  const file = join(dir, "probe.pike");
  writeFileSync(file, src);
  try {
    execFileSync(PIKE, ["-e", `compile_file("${file}");`], { encoding: "utf8", stdio: "pipe", cwd: dir });
    return null;
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string };
    return (e.stderr ?? "") + (e.stdout ?? "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("organize imports moves only imports", () => {
  test("sorts the imports", () => {
    const fixed = applyEdits(SRC, organizeImports(SRC));
    expect(fixed.indexOf("import Array;")).toBeLessThan(fixed.indexOf("import Stdio;"));
  });

  test("keeps the inherit clause between the imports", () => {
    const fixed = applyEdits(SRC, organizeImports(SRC));
    expect(fixed).toContain('inherit "base-lib.pike";');
  });

  test("keeps a comment between the imports", () => {
    const fixed = applyEdits(SRC, organizeImports(SRC));
    expect(fixed).toContain("// keep this comment");
  });

  test("keeps the rest of the file", () => {
    const fixed = applyEdits(SRC, organizeImports(SRC));
    expect(fixed).toContain("return helper_value();");
    expect(fixed).toContain("#pragma strict_types");
  });

  test("deduplicates repeated imports without eating neighbours", () => {
    const src = `import Stdio;\ninherit "base-lib.pike";\nimport Stdio;\nimport Array;\n\nint main() { return helper_value(); }\n`;
    const fixed = applyEdits(src, organizeImports(src));
    expect(fixed.split("import Stdio;").length - 1, "Stdio imported once").toBe(1);
    expect(fixed).toContain('inherit "base-lib.pike";');
  });

  test("already-sorted imports produce no edits", () => {
    const src = `import Array;\nimport Stdio;\n\nint main() { return 0; }\n`;
    expect(organizeImports(src)).toEqual([]);
  });

  test.skipIf(!pikeAvailable)("pike is the oracle: the file still compiles afterwards", () => {
    // Guard the guard: the fixture must compile BEFORE the action.
    expect(compileError(SRC), "fixture must compile first").toBeNull();
    const fixed = applyEdits(SRC, organizeImports(SRC));
    expect(compileError(fixed), `organized source must still compile\n--- got ---\n${fixed}`).toBeNull();
  });
});
