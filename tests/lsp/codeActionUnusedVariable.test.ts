/**
 * Regression: the "Remove unused variable" quick fix must not delete code that
 * is still used.
 *
 * The producer computed its edit from `diag.range.start.line` and deleted
 * `line .. line+1` unconditionally — the whole physical line. For
 * `int a = 1, b = 2;` with only `a` unused that deletes `b` as well, and for a
 * one-line function body it deletes the entire function. Both results are
 * rejected by the Pike compiler, so a fix the user accepted to clean up a
 * warning left them with source that does not build.
 *
 * Every expectation here is checked by compiling the fixed text with the real
 * pike binary: an offered quick fix must never produce code that stops
 * compiling.
 */

import { describe, test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { removeUnusedVariableEdits } from "../../server/src/features/codeActionUnusedVariable";
import type { Diagnostic } from "vscode-languageserver/node.js";
import { pikeAvailable } from "../helpers/pikeAvailable";

const PIKE = process.env.PIKE_BINARY ?? "pike";

interface Range { start: { line: number; character: number }; end: { line: number; character: number } }
interface TextEdit { range: Range; newText: string }

/** Build the compiler diagnostic the quick fix matches on. */
function unusedDiag(text: string, name: string): Diagnostic {
  const lines = text.split("\n");
  for (let line = 0; line < lines.length; line++) {
    const character = lines[line].search(new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`));
    if (character < 0) continue;
    const at = lines[line].indexOf(name, character);
    return {
      range: { start: { line, character: at }, end: { line, character: at + name.length } },
      message: `Unused local variable ${name}`,
      severity: 2 as Diagnostic["severity"],
      source: "pike",
    };
  }
  throw new Error(`${name} not found`);
}

/** Apply edits last-first so earlier offsets stay valid. */
function applyEdits(src: string, edits: TextEdit[]): string {
  const lines = src.split("\n");
  const ordered = [...edits].sort(
    (a, b) => b.range.start.line - a.range.start.line ||
      b.range.start.character - a.range.start.character,
  );
  for (const e of ordered) {
    const startLine = lines[e.range.start.line];
    const endLine = lines[e.range.end.line];
    const head = startLine.slice(0, e.range.start.character);
    const tail = endLine.slice(e.range.end.character);
    lines.splice(
      e.range.start.line,
      e.range.end.line - e.range.start.line + 1,
      head + e.newText + tail,
    );
  }
  return lines.join("\n");
}

/** Compile with the real pike binary; returns null when it compiles clean. */
function compileError(src: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), "pike-ca-"));
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

describe("remove unused variable never breaks the file", () => {
  const cases: Array<{ name: string; src: string; unused: string; mustKeep: string[] }> = [
    {
      name: "a multi-declarator statement keeps the used declarators",
      src: `int main() {\n  int a = 1, b = 2;\n  return b;\n}\n`,
      unused: "a",
      mustKeep: ["b = 2", "return b"],
    },
    {
      name: "the unused declarator in the middle is the only one removed",
      src: `int main() {\n  int a = 1, b = 2, c = 3;\n  return a + c;\n}\n`,
      unused: "b",
      mustKeep: ["a = 1", "c = 3"],
    },
    {
      name: "the last declarator is removed without eating the others",
      src: `int main() {\n  int a = 1, b = 2;\n  return a;\n}\n`,
      unused: "b",
      mustKeep: ["a = 1", "return a"],
    },
    {
      name: "a one-line function keeps the function",
      src: `int helper() { int unused = 1; return 7; }\nint main() { return helper(); }\n`,
      unused: "unused",
      mustKeep: ["int helper()", "return 7", "helper()"],
    },
    {
      name: "a lone declaration on its own line is removed entirely",
      src: `int main() {\n  int solo = 1;\n  return 0;\n}\n`,
      unused: "solo",
      mustKeep: ["int main()", "return 0"],
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const edits = removeUnusedVariableEdits(unusedDiag(c.src, c.unused), c.src);
      // Declining is always allowed; producing a broken file is not.
      if (edits.length === 0) return;
      const fixed = applyEdits(c.src, edits);
      for (const keep of c.mustKeep) {
        expect(fixed, `${c.name}: must keep ${JSON.stringify(keep)}\n--- got ---\n${fixed}`)
          .toContain(keep);
      }
      expect(fixed).not.toContain(`${c.unused} =`);
    });
  }

  test.skipIf(!pikeAvailable)("pike is the oracle: every fixed file still compiles", () => {
    for (const c of cases) {
      // Guard the guard: the fixture must compile BEFORE the fix is applied.
      expect(compileError(c.src), `${c.name}: fixture must compile first`).toBeNull();

      const edits = removeUnusedVariableEdits(unusedDiag(c.src, c.unused), c.src);
      if (edits.length === 0) continue;
      const fixed = applyEdits(c.src, edits);
      expect(compileError(fixed), `${c.name}: fixed source must still compile\n--- got ---\n${fixed}`)
        .toBeNull();
    }
  });
});
