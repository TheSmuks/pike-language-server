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

/** Build the signature header block (fenced pike code). */
function buildSignatureBlock(signatures: string[]): string[] {
  if (signatures.length === 0) return [];
  const lines: string[] = ["```pike"];
  lines.push(...signatures);
  lines.push("```");
  return lines;
}

/** Collect all signatures from a docGroup's non-doc children. */
function collectSignatures(
  docGroup: import("./xmlParser").XmlNode,
  fallbackSignature: string | undefined,
): string[] {
  const signatures: string[] = [];

  for (const child of docGroup.children ?? []) {
    if (child.type === "element" && child.tag !== "doc" && child.tag !== "source-position") {
      const sig = renderSignature(child);
      if (sig) signatures.push(sig);
    }
  }

  if (signatures.length === 0 && fallbackSignature) {
    signatures.push(fallbackSignature);
  }
  return signatures;
}

/** Build the markdown parts array from signatures and doc element. */
function buildMarkdownParts(
  signatures: string[],
  docEl: import("./xmlParser").XmlNode | undefined,
): string[] {
  const parts: string[] = [];
  const sigBlock = buildSignatureBlock(signatures);
  parts.push(...sigBlock);

  if (docEl) {
    const docLines = renderBlocks([docEl]);
    if (docLines.length > 0) {
      parts.push("");
      parts.push(...docLines);
    }
  }

  return parts;
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

  let docGroup = findDocGroup(root, symbolName);
  if (!docGroup) {
    docGroup = findClass(root, symbolName);
  }

  if (!docGroup) return null;

  const docEl = (docGroup.children ?? []).find(
    (c) => c.type === "element" && c.tag === "doc",
  );

  const signatures = collectSignatures(docGroup, fallbackSignature);
  if (signatures.length === 0) return null;

  const parts = buildMarkdownParts(signatures, docEl);
  return {
    markdown: parts.join("\n"),
    signature: signatures[0],
  };
}
