/**
 * Constants the Pike compiler defines itself.
 *
 * None of them is declared in any Pike source, so they are absent from the
 * autodoc-derived builtin index and every lookup tier walked past them.
 * `UNDEFINED` alone appears 170 times in Roxen 6.1 and `__FILE__` 58.
 *
 * The set was taken from the compiler rather than from documentation: each
 * name below compiles and prints under Pike 8.0.1116, and `__NT__` — which
 * Roxen writes 96 times — is deliberately absent because it does not
 * (`Undefined identifier __NT__.`; it exists only on Windows), so hovering it
 * on this platform correctly answers nothing.
 *
 * The descriptions say what each names, never what it currently equals: the
 * value depends on the file, the line and the Pike doing the compiling, and a
 * server that answered `8.0` for `__VERSION__` would be quoting its own
 * development machine at the reader.
 */

import type { Hover, CompletionItem } from "vscode-languageserver/node";
import { CompletionItemKind } from "vscode-languageserver/node";
import { formatHover } from "./hoverContent";
import { padSortKey } from "./completion-items";

export interface MagicConstant {
  /** Type as the compiler yields it, for the signature line. */
  type: string;
  description: string;
}

export const PIKE_MAGIC_CONSTANTS: Record<string, MagicConstant> = {
  UNDEFINED: {
    type: "mixed",
    description:
      "The undefined value. Equal to `0`, and distinguished from it by " +
      "`zero_type()`, which returns 1 for `UNDEFINED` and 0 for a plain zero — " +
      "that is how a missing mapping entry is told from one holding `0`.",
  },
  __FILE__: { type: "string", description: "Path of the file being compiled." },
  __DIR__: { type: "string", description: "Directory holding the file being compiled." },
  __LINE__: { type: "int", description: "Line number this constant appears on." },
  __DATE__: { type: "string", description: "Date of compilation, as `\"Mmm DD YYYY\"`." },
  __TIME__: { type: "string", description: "Time of compilation, as `\"HH:MM:SS\"`." },
  __VERSION__: { type: "float", description: "Pike version as major.minor, e.g. `8.0`." },
  __REAL_VERSION__: { type: "float", description: "Pike version, ignoring any compatibility level in force." },
  __MAJOR__: { type: "int", description: "Pike major version." },
  __MINOR__: { type: "int", description: "Pike minor version." },
  __BUILD__: { type: "int", description: "Pike build number." },
  __PIKE__: { type: "int", description: "Always 1. Present so code can detect it is being compiled by Pike." },
  __AUTO_BIGNUM__: { type: "int", description: "Always 1 in Pike 8: integers promote to bignums automatically." },
};

/** Hover for a compiler-defined constant, or null when the name is not one. */
export function magicConstantHover(
  name: string,
  position: { line: number; character: number },
): Hover | null {
  const entry = Object.prototype.hasOwnProperty.call(PIKE_MAGIC_CONSTANTS, name)
    ? PIKE_MAGIC_CONSTANTS[name]
    : null;
  if (!entry) return null;

  return formatHover({
    name,
    signature: `${entry.type} ${name}`,
    documentation: entry.description,
    line: position.line,
    character: position.character,
  });
}

/**
 * Offer the constants the compiler defines.
 *
 * They are not functions and take no arguments, so they get Constant kind and
 * no snippet — `__FILE__(` would be wrong. Sorted with the builtins, since
 * that is what they are from the reader's side.
 */
export function collectMagicConstantItems(
  items: CompletionItem[], seenNames: Set<string>,
): void {
  for (const [name, entry] of Object.entries(PIKE_MAGIC_CONSTANTS)) {
    if (seenNames.has(name)) continue;
    seenNames.add(name);
    items.push({
      label: name,
      kind: CompletionItemKind.Constant,
      detail: `${entry.type} ${name}`,
      documentation: entry.description,
      sortText: padSortKey(30) + name,
      filterText: name,
    });
  }
}
