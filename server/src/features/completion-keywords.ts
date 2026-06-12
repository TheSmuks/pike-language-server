/**
 * Keyword / snippet completions for Pike LSP.
 *
 * Extracted from completion.ts (design decision 0012).
 */

import {
  CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
} from "vscode-languageserver/node";
import { padSortKey } from "./completion-items";

/**
 * Pike keywords with snippet bodies for control flow and declarations.
 *
 * Only keywords that produce useful snippet expansions are included here.
 * Bare type keywords (int, string, array, ...) and modifiers (private, static, ...)
 * are excluded — they are too short to benefit from snippets and would pollute
 * the completion list without adding value over plain typing.
 *
 * Source: Pike lexer src/lexer.h keyword switch + Pike manual ch2-7.
 */
export const KEYWORD_SNIPPETS: ReadonlyArray<{
  label: string;
  insertText: string;
  detail: string;
}> = [
  // Control flow — most common, highest utility.
  { label: "if", insertText: "if (${1:condition}) {\n\t$0\n}", detail: "if statement" },
  { label: "else", insertText: "else {\n\t$0\n}", detail: "else block" },
  { label: "else if", insertText: "else if (${1:condition}) {\n\t$0\n}", detail: "else-if chain" },
  { label: "for", insertText: "for (${1:init}; ${2:condition}; ${3:update}) {\n\t$0\n}", detail: "for loop" },
  { label: "foreach", insertText: "foreach (${1:container}; ${2:key}; ${3:value}) {\n\t$0\n}", detail: "foreach loop" },
  { label: "while", insertText: "while (${1:condition}) {\n\t$0\n}", detail: "while loop" },
  { label: "do", insertText: "do {\n\t$0\n} while (${1:condition});", detail: "do-while loop" },
  { label: "switch", insertText: "switch (${1:expression}) {\n\tcase ${2:value}:\n\t\t$0\n\t\tbreak;\n}", detail: "switch statement" },
  { label: "case", insertText: "case ${1:value}:\n\t$0\n\tbreak;", detail: "case clause" },
  { label: "default", insertText: "default:\n\t$0\n\tbreak;", detail: "default clause" },

  // Exception handling.
  { label: "catch", insertText: "catch (${1:error}) {\n\t$0\n}", detail: "catch block" },

  // Declarations — structural, high value.
  { label: "class", insertText: "class ${1:Name} {\n\t$0\n}", detail: "class declaration" },
  { label: "enum", insertText: "enum ${1:Name} {\n\t$0\n}", detail: "enum declaration" },
  { label: "typedef", insertText: "typedef ${1:type} ${2:Name};", detail: "typedef declaration" },
  { label: "constant", insertText: "constant ${1:Name} = ${2:value};", detail: "constant declaration" },

  // Lambda / inline function.
  { label: "lambda", insertText: "lambda(${1:params}) {\n\t$0\n}", detail: "lambda expression" },

  // Import / inherit.
  { label: "inherit", insertText: "inherit ${1:module};", detail: "inherit module" },
  { label: "import", insertText: "import ${1:module};", detail: "import module" },

  // Special expression keywords.
  { label: "gauge", insertText: "gauge ${1:expression};", detail: "gauge expression (timing)" },
  { label: "sscanf", insertText: "sscanf(${1:input}, \"${2:format}\", ${3:vars})", detail: "sscanf formatted input" },
  { label: "typeof", insertText: "typeof(${1:expression})", detail: "typeof expression" },
];

/**
 * Add keyword snippet completions.
 *
 * Keyword completions are sorted after all symbol completions (priority 60)
 * so that identifiers, functions, and modules always appear first.
 * Skipped if the keyword name collides with an already-seen identifier
 * (a local variable named "for" would shadow the keyword, which is unlikely
 * but handled for correctness).
 */
export function collectKeywordSnippets(
  items: CompletionItem[],
  seenNames: Set<string>,
): void {
  for (const kw of KEYWORD_SNIPPETS) {
    if (seenNames.has(kw.label)) continue;
    seenNames.add(kw.label);
    items.push({
      label: kw.label,
      kind: CompletionItemKind.Keyword,
      detail: kw.detail,
      sortText: padSortKey(60) + kw.label,
      filterText: kw.label,
      insertText: kw.insertText,
      insertTextFormat: InsertTextFormat.Snippet,
    });
  }
}
