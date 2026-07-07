/**
 * Autodoc-skeleton completion — the "fill-in template" trigger.
 *
 * When the user types `//!` on a line directly above a function, method,
 * class, or variable declaration, this offers a single snippet completion
 * that expands into a `//!` autodoc skeleton derived from the declaration's
 * signature, with tab-stops the user can Tab through (name/description, one
 * per `@param`, and `@returns`). This mirrors the docstring-on-`"""`
 * experience in Python and the `/**`-on-Enter experience for Java.
 *
 * The plain-text, code-action form lives in autodocTemplate.ts (`//!!`
 * trigger); both share the declaration- and parameter-lookup helpers.
 */

import {
  CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
  MarkupKind,
} from "vscode-languageserver/node";
import type { SymbolTable, Declaration } from "./symbolTable";
import { findDocumentableDeclAtLine, collectFunctionParamNames } from "./autodocTemplate";

// Matches an indent-only `//!` doc-comment marker (with optional trailing
// spaces) — the text left of the cursor when the completion should fire.
// `//!!` does not match (that is the code-action trigger).
const DOC_TRIGGER = /^(\s*)\/\/!\s*$/;

// Bound the forward scan for the documented declaration so a stray `//!` far
// above any code does not walk the whole file.
const MAX_SCAN_LINES = 20;

/**
 * Build the autodoc-skeleton completion for the given cursor position, or
 * null when the cursor is not on an empty `//!` line above a declaration.
 */
export function buildAutodocCompletion(
  table: SymbolTable,
  line: number,
  character: number,
  source: string,
): CompletionItem | null {
  const lines = source.split("\n");
  const cur = lines[line] ?? "";

  const before = cur.slice(0, character);
  const match = DOC_TRIGGER.exec(before);
  if (!match) return null;
  // Don't clobber content the user already typed after the cursor.
  if (cur.slice(character).trim() !== "") return null;

  const decl = findDeclBelow(lines, table, line + 1);
  if (!decl) return null;

  const indent = match[1];
  const newText = buildSnippet(decl, table);

  return {
    label: "//! autodoc skeleton",
    kind: CompletionItemKind.Snippet,
    detail: `Generate autodoc for ${decl.kind} "${decl.name}"`,
    insertTextFormat: InsertTextFormat.Snippet,
    // Match what the user has typed so the item stays selected as they type.
    filterText: "//!",
    sortText: "0",
    preselect: true,
    textEdit: {
      range: {
        start: { line, character: indent.length },
        end: { line, character },
      },
      newText: newText.replace(/\n/g, `\n${indent}`),
    },
    documentation: {
      kind: MarkupKind.Markdown,
      value: "```pike\n" + newText.replace(/\$\{\d+:([^}]*)\}/g, "$1") + "\n```",
    },
  };
}

/**
 * Find the documented declaration below a `//!` line — the first meaningful
 * line, skipping blank lines and other comment lines (existing doc lines).
 */
function findDeclBelow(
  lines: string[],
  table: SymbolTable,
  fromLine: number,
): Declaration | null {
  const limit = Math.min(lines.length, fromLine + MAX_SCAN_LINES);
  for (let i = fromLine; i < limit; i++) {
    const trimmed = (lines[i] ?? "").trim();
    if (trimmed === "" || trimmed.startsWith("//")) continue;
    return findDocumentableDeclAtLine(table, i);
  }
  return null;
}

/**
 * Build the snippet body (leading `//! ` on every line, `\n`-separated, no
 * outer indent — the caller re-indents continuation lines).
 */
function buildSnippet(decl: Declaration, table: SymbolTable): string {
  let tab = 1;
  const out: string[] = [`//! \${${tab++}:${decl.name} — description.}`];

  if (decl.kind === "function" || decl.kind === "method") {
    for (const name of collectFunctionParamNames(decl, table)) {
      out.push(`//! @param ${name}`, `//!   \${${tab++}:Description.}`);
    }
    if (decl.declaredType && decl.declaredType !== "void") {
      out.push(`//! @returns`, `//!   \${${tab++}:Description.}`);
    }
  }

  return out.join("\n");
}
