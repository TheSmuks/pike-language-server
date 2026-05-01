/**
 * AutoDoc XML Renderer — converts PikeExtractor XML to LSP hover markdown.
 *
 * Architecture (per decision 0011 §7):
 *   Source → PikeExtractor.extractNamespace() → XML → this module → Markdown
 *
 * The TypeScript code is a renderer, not a parser of Pike's //! syntax.
 * Input is XML conforming to the documented PikeExtractor schema.
 * Every tag in the schema has a render path; rare tags use plain-text fallback.
 */

import {
  parseXml,
  findDocGroup,
  findClass,
  renderSignature,
  renderBlocks,
} from "./xmlParser";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RenderedAutodoc {
  /** Markdown content for LSP hover. */
  markdown: string;
  /** Extracted signature (e.g., "int foo(int x, int y)"). */
  signature: string;
}

/**
 * Render AutoDoc XML for a specific symbol to markdown.
 *
 * @param xml     XML string from PikeExtractor (full file XML)
 * @param symbolName  Name of the symbol to render (method, class, variable, etc.)
 * @param fallbackSignature  Tree-sitter extracted signature to use if XML has no method element
 * @returns Rendered markdown and signature, or null if symbol not documented
 */
export function renderAutodoc(
  xml: string,
  symbolName: string,
  fallbackSignature?: string,
): RenderedAutodoc | null {
  if (!xml) return null;

  const root = parseXml(xml);

  // Try to find a <docgroup> for this symbol
  let docGroup = findDocGroup(root, symbolName);

  // If not found as docgroup, try as <class>
  if (!docGroup) {
    docGroup = findClass(root, symbolName);
  }

  if (!docGroup) return null;

  // Extract signature from the <method>, <variable>, <class>, etc. element
  const signatures: string[] = [];
  const docEl = (docGroup.children ?? []).find(
    (c) => c.type === "element" && c.tag === "doc",
  );

  for (const child of docGroup.children ?? []) {
    if (child.type === "element" && child.tag !== "doc" && child.tag !== "source-position") {
      const sig = renderSignature(child);
      if (sig) {
        signatures.push(sig);
      }
    }
  }

  // Use first signature as primary; show all overloads in header
  if (signatures.length === 0 && fallbackSignature) {
    signatures.push(fallbackSignature);
  }
  const signature = signatures[0] ?? "";

  // Render documentation
  const parts: string[] = [];

  // Signature header — show all overloads
  if (signatures.length > 0) {
    parts.push("```pike");
    for (const sig of signatures) {
      parts.push(sig);
    }
    parts.push("```");
  }

  // Documentation content
  if (docEl) {
    const docLines = renderBlocks([docEl]);
    if (docLines.length > 0) {
      parts.push("");
      parts.push(...docLines);
    }
  }

  if (parts.length === 0) return null;

  return {
    markdown: parts.join("\n"),
    signature,
  };
}
