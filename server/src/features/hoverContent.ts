/**
 * Hover content formatting — declaration-to-hover-info conversion.
 *
 * Extracted from hoverHandler.ts to keep it under 500 lines.
 * Re-exported by hoverHandler.ts so existing imports continue to work.
 */

import { MarkupKind } from "vscode-languageserver/node";
import type { MarkupContent, Hover } from "vscode-languageserver/node";
import type { TextDocuments } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { parse } from "../parser";
import type { Node } from "web-tree-sitter";
import type { Declaration } from "./symbolTable";
import { renderAutodoc } from "./autodocRenderer";
import type { LRUCache } from "../util/lruCache";
import { stripScopeWrapper } from "../util/stripScope";
import { readFileSync } from "node:fs";
import { uriToPath } from "../util/uri";
import { fileLevelHover } from "./hoverContent-file";
import { renderAutodocLines } from "./autodocLineRenderer";

// Re-export for backward compatibility
export { fileLevelHover };

export interface HoverInfo {
  name: string;
  signature: string;
  documentation: string;
  line: number;
  character: number;
  /** If true, documentation is already full markdown (from autodoc). */
  isAutodoc?: boolean;
}

export interface PredefAutodocEntry {
  signature: string;
  markdown: string;
  params?: Array<{ name: string; type: string }>;
  returnType?: string;
}

export interface HoverContentContext {
  documents: TextDocuments<TextDocument>;
  autodocCache: LRUCache<{ xml: string; hash: string; timestamp: number }>;
  stdlibIndex: Record<string, { signature: string; markdown: string }>;
  predefBuiltins: Record<string, string>;
  predefAutodoc: Record<string, PredefAutodocEntry>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Render a predef builtin type signature into human-readable display lines.
 *
 * Pike runtime signatures look like:
 *   `scope(0, function(void : int) | function(int : float))`
 *
 * This function strips scope wrappers and renders each overload as a
 * separate `name(params) → returnType` line for clarity.
 *
 * @returns Array of rendered signature strings (one per overload)
 */
export function renderPredefSignature(name: string, rawSig: string): string[] {
  let cleanSig = stripScopeWrapper(rawSig);
  // Remove attribute annotations for cleaner display
  cleanSig = cleanSig.replace(/__attribute__\("[^"]*",\s*/g, "");

  const overloads = extractOverloads(cleanSig);
  if (overloads.length === 0) return [`${name}()`];

  return overloads.map(sig => {
    const parsed = parseFunctionType(sig);
    if (!parsed) return `${name}()`;
    const paramList = cleanPikeType(parsed.params);
    const returnType = cleanPikeType(parsed.returnType);
    return `${name}(${paramList}) → ${returnType}`;
  });
}

/**
 * Clean Pike type annotations for display.
 * - `void | int(1bit)` → `void|int` (optional parameter indicator)
 * - `int(2..2147483647)` → `int`
 * - `int(1bit)` → `int`
 * - Preserves meaningful constraints like `int(0..255)`
 *   only when they add clarity (range not obvious from context).
 */
function cleanPikeType(type: string): string {
  let result = type.trim();
  // Remove bit-width constraints — `int(1bit)` → `int`
  result = result.replace(/\bint\(\d+bit\)/g, "int");
  // Remove full-range constraints — `int(2..2147483647)` → `int`
  result = result.replace(/\bint\(\d+\.\.\d+\)/g, "int");
  // Collapse whitespace around |
  result = result.replace(/\s*\|\s*/g, "|");
  // void|int means optional parameter — display as `void|int`
  return result;
}

/**
 * Extract individual function(...) overload strings from a union type.
 * Handles balanced parens so `|` inside function params is not misinterpreted.
 *
 * Input:  `function(void : int) | function(int : float)`
 * Output: [`function(void : int)`, `function(int : float)`]
 */
function extractOverloads(unionSig: string): string[] {
  const results: string[] = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < unionSig.length; i++) {
    const ch = unionSig[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;

    // Split on ` | function` at top level only
    if (depth === 0 && unionSig.slice(i).startsWith(" | function(")) {
      results.push(unionSig.slice(start, i).trim());
      start = i + 3; // skip " | "
      i += 2; // skip "| " — loop will skip " f" naturally
    }
  }

  const remaining = unionSig.slice(start).trim();
  if (remaining) results.push(remaining);
  return results.filter(s => s.length > 0);
}

/** Parsed function type: params and return type. */
interface FunctionType {
  params: string;
  returnType: string;
}

/**
 * Parse `function(params : returnType)` into its components.
 * Handles balanced parens so `:` inside nested types is not misinterpreted.
 */
function parseFunctionType(sig: string): FunctionType | null {
  const match = sig.match(/^function\(/);
  if (!match) return null;

  const inner = sig.slice(match[0].length);
  // Walk to find the matching `)` and the top-level `:` separator
  let depth = 1;
  let colonPos = -1;
  let endPos = -1;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        endPos = i;
        break;
      }
    } else if (ch === ":" && depth === 1 && colonPos === -1) {
      colonPos = i;
    }
  }

  if (endPos === -1 || colonPos === -1) {
    // Malformed — return the inner content as params with unknown return
    return { params: inner.replace(/\)$/, ""), returnType: "mixed" };
  }

  return {
    params: inner.slice(0, colonPos).trim(),
    returnType: inner.slice(colonPos + 1, endPos).trim(),
  };
}

/**
 * Build hover markdown for a predef builtin function.
 * Shows each overload as a separate code line in a pike code block.
 */
export function buildPredefHoverMarkdown(name: string, overloads: string[], autodocEntry?: PredefAutodocEntry): string {
  const lines: string[] = ["```pike"];
  for (const sig of overloads) {
    lines.push(sig);
  }
  lines.push("```");

  if (autodocEntry?.markdown) {
    lines.push("");
    lines.push(autodocEntry.markdown);
  }

  if (autodocEntry?.params && autodocEntry.params.length > 0) {
    lines.push("");
    lines.push("**Parameters:**");
    for (const p of autodocEntry.params) {
      lines.push(`- \`${p.name}\` (\`${p.type}\`)`);
    }
  }

  if (autodocEntry?.returnType) {
    lines.push("");
    lines.push(`**Returns:** \`${autodocEntry.returnType}\``);
  }

  return lines.join("\n");
}

/** Format a declaration into a Hover response. */
export function formatHover(info: HoverInfo | null): Hover | null {
  if (!info) return null;

  let value: string;
  if (info.isAutodoc && info.documentation) {
    // Autodoc already rendered as full markdown with signature
    value = info.documentation;
  } else {
    // Tier 3: bare tree-sitter signature
    const parts: string[] = [];
    parts.push("```pike");
    parts.push(info.signature);
    parts.push("```");
    if (info.documentation) {
      parts.push("");
      parts.push(info.documentation);
    }
    value = parts.join("\n");
  }

  const contents: MarkupContent = {
    kind: MarkupKind.Markdown,
    value,
  };

  return {
    contents,
    range: {
      start: { line: info.line, character: info.character },
      end: { line: info.line, character: info.character + info.name.length },
    },
  };
}

export function getSource(uri: string, documents: TextDocuments<TextDocument>): string | null {
  const doc = documents.get(uri);
  if (doc) return doc.getText();
  // Cross-file: document not open in editor. Read from disk.
  if (uri.startsWith("file://")) {
    try {
      return readFileSync(uriToPath(uri), "utf8");
    } catch {
      // Disk/permission errors — fall through to return null.
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Signature extraction
// ---------------------------------------------------------------------------

/** Extract and clean the declaration signature from source lines. */
function extractSignature(
  decl: {
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
  },
  lines: string[],
): string {
  const startLine = decl.range.start.line;
  const endLine = decl.range.end.line;
  const startChar = decl.range.start.character;
  const endChar = decl.range.end.character;
  let raw: string;
  if (startLine === endLine) {
    raw = (lines[startLine] ?? "").slice(startChar, endChar);
  } else {
    const parts: string[] = [];
    for (let i = startLine; i <= endLine; i++) {
      const line = lines[i] ?? "";
      if (i === startLine) {
        parts.push(line.slice(startChar));
      } else if (i === endLine) {
        parts.push(line.slice(0, endChar));
      } else {
        parts.push(line);
      }
    }
    raw = parts.join("\n");
  }
  return raw
    .trim()
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/m, "")
    .replace(/\s*\{[\s\S]*$/, "")
    .replace(/\s*;\s*$/, "")
    .trim();
}

// ---------------------------------------------------------------------------
// Tier resolution helpers
// ---------------------------------------------------------------------------

/** Make a HoverInfo object with common fields filled. */
function makeHoverInfo(
  decl: { name: string; nameRange: { start: { line: number; character: number } } },
  signature: string,
  documentation: string,
  isAutodoc = false,
): HoverInfo {
  return {
    name: decl.name,
    signature,
    documentation,
    line: decl.nameRange.start.line,
    character: decl.nameRange.start.character,
    isAutodoc,
  };
}

/** Tier 1: Workspace AutoDoc — render from cached XML. */
function hoverFromAutodoc(
  uri: string,
  decl: { name: string; nameRange: { start: { line: number; character: number } } },
  signature: string,
  ctx: HoverContentContext,
): HoverInfo | null {
  const cachedAutodoc = ctx.autodocCache.get(uri);
  if (!cachedAutodoc?.xml) return null;

  const rendered = renderAutodoc(cachedAutodoc.xml, decl.name, signature);
  if (!rendered) return null;

  return makeHoverInfo(decl, rendered.signature || signature, rendered.markdown, true);
}

/** Tier 2: Stdlib + predef builtins — hash-table lookup. */
function hoverFromStdlib(
  decl: { name: string; nameRange: { start: { line: number; character: number } } },
  signature: string,
  ctx: HoverContentContext,
): HoverInfo | null {
  const entry = ctx.stdlibIndex[`predef.${decl.name}`];
  if (entry) {
    return makeHoverInfo(decl, entry.signature, entry.markdown, true);
  }

  const builtinSig = ctx.predefBuiltins[decl.name];
  if (builtinSig) {
    const overloads = renderPredefSignature(decl.name, builtinSig);
    const autodocEntry = ctx.predefAutodoc?.[decl.name];
    return makeHoverInfo(
      decl,
      overloads.join("\n"),
      buildPredefHoverMarkdown(decl.name, overloads, autodocEntry),
      true,
    );
  }

  return null;
}

/** Scan backwards from declLine, collecting //! autodoc lines. */
function collectAutodocLines(lines: string[], declLine: number): string[] {
  const autodocLines: string[] = [];
  let scanLine = declLine - 1;
  while (scanLine >= 0) {
    const lineText = (lines[scanLine] ?? "").trimEnd();
    if (lineText.endsWith("*/")) {
      // Skip over block comments by scanning back to the opening /*.
      // Default to bailing out in case /* is never found (malformed input)
      // to avoid an infinite loop when scanLine is not decremented.
      const commentEnd = scanLine;
      scanLine = -1;
      for (let bl = commentEnd; bl >= 0; bl--) {
        if ((lines[bl] ?? "").includes("/*")) {
          scanLine = bl - 1;
          break;
        }
      }
      continue;
    }
    const match = lineText.match(/^\/\/!\s?(.*)/);
    if (match) {
      autodocLines.unshift(match[1]);
      scanLine--;
    } else if (lineText === "" || lineText.startsWith("//")) {
      scanLine--;
    } else {
      break;
    }
  }
  return autodocLines;
}

/** Group autodoc lines into paragraphs on blank separators. */
function autodocParagraphs(autodocLines: string[]): string[] {
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of autodocLines) {
    if (line.length === 0) {
      if (current.length > 0) {
        paragraphs.push(current.join(" "));
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) paragraphs.push(current.join(" "));
  return paragraphs;
}

/** Tier 2b: //! autodoc comments above the declaration. */
function hoverFromComments(
  decl: { name: string; nameRange: { start: { line: number; character: number } } },
  signature: string,
  lines: string[],
): HoverInfo | null {
  const declLine = decl.nameRange.start.line;
  if (declLine <= 0) return null;

  const autodocLines = collectAutodocLines(lines, declLine);
  if (autodocLines.length === 0) return null;

  const paragraphs = autodocParagraphs(autodocLines);
  if (paragraphs.length === 0) return null;

  const rendered = renderAutodocLines(autodocLines);
  return makeHoverInfo(decl, signature, rendered || paragraphs.join("\n\n"), true);
}

// ---------------------------------------------------------------------------
// Public: declForHover
// ---------------------------------------------------------------------------

/**
 * Build hover info for a declaration from any source.
 * Implements the three-tier hover resolution:
 *   Tier 1: Workspace AutoDoc — XML from PikeExtractor (cached)
 *   Tier 2: Stdlib — pre-computed index (hash lookup)
 *   Tier 3: Tree-sitter — bare declared type
 */
export function declForHover(
  decl: {
    name: string;
    kind: string;
    nameRange: { start: { line: number; character: number } };
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
  },
  uri: string,
  ctx: HoverContentContext,
): HoverInfo | null {
  const source = getSource(uri, ctx.documents) ?? ctx.documents.get(uri)?.getText() ?? "";
  const lines = source.split("\n");
  const signature = extractSignature(decl, lines);

  // Tier 1: Workspace AutoDoc — check XML cache, render from XML
  const autodoc = hoverFromAutodoc(uri, decl, signature, ctx);
  if (autodoc) return autodoc;

  // Tier 2: Stdlib + predef builtins
  const stdlib = hoverFromStdlib(decl, signature, ctx);
  if (stdlib) return stdlib;

  // Tier 2b: //! autodoc comments above the declaration
  const comments = hoverFromComments(decl, signature, lines);
  if (comments) return comments;

  // Tier 3: Fall through to tree-sitter declared type
  return makeHoverInfo(decl, signature, "");
}

// fileLevelHover moved to hoverContent-file.ts (see re-export above)
