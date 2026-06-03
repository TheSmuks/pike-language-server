// ---------------------------------------------------------------------------
// xml-renderer-inline.ts: Inline markdown rendering from AutoDoc XML
// Extracted from xml-renderer.ts to reduce file size.
// ---------------------------------------------------------------------------
import type { XmlNode } from './xmlParser';

// ---------------------------------------------------------------------------
// Inline markdown rendering
// ---------------------------------------------------------------------------

/** Render inline text content (inside <p>, <text>, etc.) to markdown. */
export function renderInline(nodes: XmlNode[]): string {
  return nodes.map(renderInlineNode).join("");
}

function renderInlineNode(node: XmlNode): string {
  if (node.type === "text") {
    return node.text ?? "";
  }

  switch (node.tag) {
    case "b":
      return bold(node);
    case "i":
      return italic(node);
    case "tt":
    case "code":
      return inlineCode(node);
    case "pre":
      return renderInline(node.children ?? []);
    case "ref":
      return renderInline(node.children ?? []);
    case "expr":
      return inlineCode(node);
    case "u":
      return underline(node);
    case "sup":
      return superscript(node);
    case "sub":
      return subscript(node);
    case "url":
      return renderUrl(node);
    case "rfc":
      return rfc(node);
    default:
      return renderInline(node.children ?? []);
  }
}

function bold(node: XmlNode): string {
  return `**${renderInline(node.children ?? [])}**`;
}

function italic(node: XmlNode): string {
  return `*${renderInline(node.children ?? [])}*`;
}

function inlineCode(node: XmlNode): string {
  return `\`${renderInline(node.children ?? [])}\``;
}

function underline(node: XmlNode): string {
  return `__${renderInline(node.children ?? [])}__`;
}

function superscript(node: XmlNode): string {
  return `**${renderInline(node.children ?? [])}**^`;
}

function subscript(node: XmlNode): string {
  return `_${renderInline(node.children ?? [])}_`;
}

function renderUrl(node: XmlNode): string {
  const url = (node.attrs?.["href"] ?? "").trim();
  const label = node.children?.length ? renderInline(node.children) : url;
  return label;
}

function rfc(node: XmlNode): string {
  return `RFC ${renderInline(node.children ?? [])}`;
}
