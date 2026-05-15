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
  const parts: string[] = [];

  for (const node of nodes) {
    if (node.type === "text") {
      const t = node.text ?? "";
      // Do NOT collapse whitespace here — whitespace is significant in <pre> contexts
      // and preserving line structure is necessary for proper paragraph handling.
      // Entities are already decoded by the XML parser.
      parts.push(t);
      continue;
    }

    switch (node.tag) {
      // Inline formatting
      case "b":
        parts.push(`**${renderInline(node.children ?? [])}**`);
        break;
      case "i":
        parts.push(`*${renderInline(node.children ?? [])}*`);
        break;
      case "tt":
      case "code":
        parts.push(`\`${renderInline(node.children ?? [])}\``);
        break;
      case "pre":
        parts.push(renderInline(node.children ?? []));
        break;

      case "ref":
        parts.push(renderInline(node.children ?? []));
        break;

      case "expr":
        parts.push(`\`${renderInline(node.children ?? [])}\``);
        break;

      case "u":
        parts.push(`__${renderInline(node.children ?? [])}__`);
        break;

      case "sup":
        parts.push(`**${renderInline(node.children ?? [])}**^`);
        break;

      case "sub":
        parts.push(`_${renderInline(node.children ?? [])}_`);
        break;

      case "url": {
        const url = (node.attrs?.["href"] ?? "").trim();
        const label = node.children?.length
          ? renderInline(node.children)
          : url;
        parts.push(label);
        break;
      }

      case "rfc":
        parts.push(`RFC ${renderInline(node.children ?? [])}`);
        break;

      default:
        parts.push(renderInline(node.children ?? []));
        break;
    }
  }

  return parts.join("");
}
