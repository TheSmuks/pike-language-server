/**
 * The "Remove unused variable" quick fix.
 *
 * Extracted from codeAction.ts, which is at the 500-line limit.
 *
 * The original producer deleted the whole physical line the diagnostic pointed
 * at. That is right only when the declaration is alone on its line. For
 * `int a = 1, b = 2;` with `a` unused it deleted `b` too, and for
 * `int helper() { int unused = 1; return 7; }` it deleted the entire function —
 * in both cases the file stopped compiling, from a fix the user accepted to
 * clear a warning.
 *
 * Only `text` is available here (no parse tree), so the statement is located by
 * scanning a masked copy of the source in which string, character and comment
 * contents are blanked — a `;` inside a literal must not look like the end of a
 * statement. Anything this cannot resolve confidently returns no edits: an
 * absent quick fix is a minor annoyance, a destructive one is a bug report.
 */

import type { Diagnostic, TextEdit } from "vscode-languageserver/node.js";

/** Pike's warning names the variable; without a name there is nothing to remove. */
const UNUSED_NAME_RE = /^Unused local variable\s+'?([A-Za-z_][A-Za-z0-9_]*)'?/;

/**
 * A copy of `text` with string/char literal bodies and comment bodies replaced
 * by spaces, preserving length so offsets stay comparable to the original.
 */
function maskLiteralsAndComments(text: string): string {
  const out = text.split("");
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") out[i++] = " ";
    } else if (ch === "/" && text[i + 1] === "*") {
      out[i++] = " "; out[i++] = " ";
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] !== "\n") out[i] = " ";
        i++;
      }
      if (i < text.length) { out[i++] = " "; out[i++] = " "; }
    } else if (ch === '"' || ch === "'") {
      const quote = ch;
      i++; // keep the opening quote so the span is still visible
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") { out[i] = " "; i++; }
        if (i < text.length && text[i] !== "\n") out[i] = " ";
        i++;
      }
      i++;
    } else {
      i++;
    }
  }
  return out.join("");
}

/** Absolute offset of a line/character position, or -1 when out of range. */
function toOffset(lines: string[], line: number, character: number): number {
  if (line < 0 || line >= lines.length) return -1;
  let offset = 0;
  for (let i = 0; i < line; i++) offset += lines[i].length + 1;
  return offset + character;
}

/** Line/character of an absolute offset. */
function toPosition(lines: string[], offset: number): { line: number; character: number } {
  let remaining = offset;
  for (let line = 0; line < lines.length; line++) {
    if (remaining <= lines[line].length) return { line, character: remaining };
    remaining -= lines[line].length + 1;
  }
  const last = lines.length - 1;
  return { line: last, character: lines[last].length };
}

/**
 * The declaration statement containing `nameOffset`, as a half-open span whose
 * end is just past the terminating `;`. Null when it cannot be delimited.
 */
function enclosingStatement(masked: string, nameOffset: number): { start: number; end: number } | null {
  let start = nameOffset;
  while (start > 0 && !";{}".includes(masked[start - 1])) start--;
  while (start < nameOffset && /\s/.test(masked[start])) start++;

  let depth = 0;
  for (let i = nameOffset; i < masked.length; i++) {
    const ch = masked[i];
    if ("([{".includes(ch)) depth++;
    else if (")]".includes(ch)) depth--;
    else if (ch === "}") return null; // ran out of the statement without a `;`
    else if (ch === ";" && depth === 0) return { start, end: i + 1 };
  }
  return null;
}

/** Top-level comma positions inside `[from, to)` of the masked text. */
function topLevelCommas(masked: string, from: number, to: number): number[] {
  const commas: number[] = [];
  let depth = 0;
  for (let i = from; i < to; i++) {
    const ch = masked[i];
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (ch === "," && depth === 0) commas.push(i);
  }
  return commas;
}

/**
 * Is everything outside `[start, end)` on those lines only whitespace?
 * A statement that owns its lines can take them with it; one sharing a line
 * with other code must not.
 */
function ownsItsLines(lines: string[], start: number, end: number): boolean {
  const from = toPosition(lines, start);
  const to = toPosition(lines, end);
  const before = lines[from.line].slice(0, from.character);
  const after = lines[to.line].slice(to.character);
  return before.trim() === "" && after.trim() === "";
}

/**
 * Offset of the declared identifier, or -1 when it cannot be located.
 *
 * The diagnostic's own position is used when it really lands on the name, which
 * is the precise case. Producers that anchor the warning at column 0 of the
 * line are common enough — the Pike compiler reports a line, not a column — so
 * the name is then found on that line as a whole word. Two occurrences on the
 * line are ambiguous only if one is a use, and a use cannot exist for a
 * variable the compiler just called unused.
 */
function locateName(
  lines: string[], text: string, line: number, character: number, name: string,
): number {
  const at = toOffset(lines, line, character);
  if (at >= 0 && text.slice(at, at + name.length) === name) return at;
  if (line < 0 || line >= lines.length) return -1;
  const word = new RegExp(`(^|[^A-Za-z0-9_])(${name})([^A-Za-z0-9_]|$)`);
  const match = word.exec(lines[line]);
  if (!match) return -1;
  const column = match.index + match[1].length;
  return toOffset(lines, line, column);
}

/**
 * Edits removing the unused variable named by `diag`, or `[]` to decline.
 */
export function removeUnusedVariableEdits(diag: Diagnostic, text: string): TextEdit[] {
  const name = UNUSED_NAME_RE.exec(diag.message)?.[1];
  if (!name) return [];

  const lines = text.split("\n");
  const nameOffset = locateName(lines, text, diag.range.start.line, diag.range.start.character, name);
  if (nameOffset < 0) return [];

  const masked = maskLiteralsAndComments(text);
  const stmt = enclosingStatement(masked, nameOffset);
  if (!stmt || nameOffset < stmt.start) return [];

  const commas = topLevelCommas(masked, stmt.start, stmt.end - 1);
  if (commas.length === 0) return removeWholeStatement(lines, text, stmt);

  // Declarator boundaries: [stmt.start, c0), (c0, c1), ... (cN, stmt.end-1).
  const bounds = [stmt.start, ...commas, stmt.end - 1];
  const index = commas.findIndex(c => nameOffset < c);
  const slot = index === -1 ? commas.length : index;
  const segStart = bounds[slot];
  const segEnd = bounds[slot + 1];

  // The name must be this declarator's own name, not part of an initializer.
  // Every declarator but the first starts AT its separating comma, which is not
  // part of the declarator text.
  const declStart = slot === 0 ? segStart : segStart + 1;
  const lead = masked.slice(declStart, nameOffset);
  if (lead.includes("=")) return [];
  // A later declarator carries no type, so only whitespace may precede its name.
  if (slot > 0 && lead.trim() !== "") return [];

  if (slot === 0) {
    // Keep the type for the survivors: drop from the name through the comma.
    let end = segEnd + 1;
    while (end < text.length && /[ \t]/.test(text[end])) end++;
    return [{ range: { start: toPosition(lines, nameOffset), end: toPosition(lines, end) }, newText: "" }];
  }
  // Drop the preceding comma along with this declarator.
  return [{
    range: { start: toPosition(lines, bounds[slot]), end: toPosition(lines, segEnd) },
    newText: "",
  }];
}

/** Remove a single-declarator statement, taking its lines only if it owns them. */
function removeWholeStatement(
  lines: string[],
  text: string,
  stmt: { start: number; end: number },
): TextEdit[] {
  if (ownsItsLines(lines, stmt.start, stmt.end)) {
    const from = toPosition(lines, stmt.start);
    const to = toPosition(lines, stmt.end);
    // Take the trailing newline with the line. On the last line there is none,
    // so take the LEADING one instead — otherwise the delete leaves an empty
    // line behind where the declaration used to be.
    const wholeLines = to.line + 1 < lines.length
      ? { start: { line: from.line, character: 0 }, end: { line: to.line + 1, character: 0 } }
      : from.line > 0
        ? { start: { line: from.line - 1, character: lines[from.line - 1].length },
            end: { line: to.line, character: lines[to.line].length } }
        : { start: { line: from.line, character: 0 },
            end: { line: to.line, character: lines[to.line].length } };
    return [{ range: wholeLines, newText: "" }];
  }
  // Shares its line with other code: take the statement and any spaces after it.
  let end = stmt.end;
  while (end < text.length && /[ \t]/.test(text[end])) end++;
  return [{ range: { start: toPosition(lines, stmt.start), end: toPosition(lines, end) }, newText: "" }];
}
