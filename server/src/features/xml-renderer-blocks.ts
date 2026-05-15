// ---------------------------------------------------------------------------
// xml-renderer-blocks.ts: Block-level documentation rendering
// Extracted from xml-renderer.ts to reduce file size.
// ---------------------------------------------------------------------------
import type { XmlNode } from './xmlParser';
import { renderType } from './xml-renderer-types';
import { renderInline } from './xml-renderer-inline';

// ---------------------------------------------------------------------------
// Block-level markdown rendering
// ---------------------------------------------------------------------------

/** Render block-level documentation content to markdown lines. */
export function renderBlocks(nodes: XmlNode[], indent = 0): string[] {
  const lines: string[] = [];
  const prefix = "  ".repeat(indent);

  for (const node of nodes) {
    if (node.type === "text") {
      const t = (node.text ?? "").trim();
      if (t) lines.push(prefix + t);
      continue;
    }

    switch (node.tag) {
      // Paragraph
      case "p": {
        const text = renderInline(node.children ?? []).trim();
        if (text) lines.push(text);
        break;
      }

      // Parameter group
      case "group": {
        const paramName = (node.children ?? [])
          .filter((c) => c.type === "element" && c.tag === "param")
          .map((c) => c.attrs?.["name"] ?? "")
          .filter(Boolean);
        const textChildren = (node.children ?? []).filter(
          (c) => c.type === "element" && c.tag === "text",
        );
        const desc = textChildren
          .flatMap((tc) => (tc.children ?? []).filter((c) => c.type === "element" && c.tag === "p"))
          .map((p) => renderInline(p.children ?? []).trim())
          .filter(Boolean)
          .join(" ");
        if (paramName.length > 0) {
          lines.push(`${prefix}- \`${paramName[0]}\` — ${desc || "(no description)"}`);
        }
        const blockChildren = textChildren.flatMap(
          (tc) => (tc.children ?? []).filter(
            (c) => c.type === "element" && c.tag !== "p"
          ),
        );
        if (blockChildren.length > 0) {
          lines.push(...renderBlocks(blockChildren, indent + 1));
        }
        const directBlocks = (node.children ?? []).filter(
          (c) => c.type === "element" &&
            c.tag !== "param" && c.tag !== "text" && c.tag !== "returns" &&
            c.tag !== "throws" && c.tag !== "note" && c.tag !== "seealso" &&
            c.tag !== "deprecated" && c.tag !== "example" && c.tag !== "bugs",
        );
        if (directBlocks.length > 0) {
          lines.push(...renderBlocks(directBlocks, indent + 1));
        }
        break;
      }

      // Text container
      case "text": {
        const blockChildren = (node.children ?? []).filter(
          (c) => c.type !== "text" || (c.text?.trim() ?? ""),
        );
        const rendered = renderBlocks(blockChildren, 0);
        if (rendered.length > 0) {
          lines.push(...rendered);
        }
        break;
      }

      case "deprecated": {
        const inner = renderInline(node.children ?? []).trim();
        lines.push(`${prefix}**Deprecated:** ${inner || "No longer recommended."}`);
        break;
      }

      case "note": {
        if (node.children && node.children.length > 0) {
          lines.push(`${prefix}**Note:** ${renderInline(node.children).trim()}`);
        }
        break;
      }

      case "bugs": {
        if (node.children && node.children.length > 0) {
          lines.push(`${prefix}**Bugs:** ${renderInline(node.children).trim()}`);
        }
        break;
      }

      case "seealso": {
        if (node.children && node.children.length > 0) {
          lines.push(`${prefix}**See also:** ${renderInline(node.children).trim()}`);
        }
        break;
      }

      case "example": {
        const content = renderInline(node.children ?? []).trim();
        if (content) {
          lines.push(`${prefix}\n${prefix}\`\`\`pike`);
          lines.push(...content.split("\n").map((l) => prefix + l));
          lines.push(`${prefix}\`\`\``);
        }
        break;
      }

      case "dl": {
        for (const child of node.children ?? []) {
          if (child.type === "element" && child.tag === "group") {
            const items = (child.children ?? []).filter(
              (c) => c.type === "element" && c.tag === "item",
            );
            const texts = (child.children ?? []).filter(
              (c) => c.type === "element" && c.tag === "text",
            );
            const itemText = items.map((i) => i.attrs?.["name"] ?? "").filter(Boolean).join(", ");
            const descText = texts
              .flatMap((t) => (t.children ?? []).filter((c) => c.type === "element" && c.tag === "p"))
              .map((p) => renderInline(p.children ?? []).trim())
              .filter(Boolean)
              .join(" ");
            if (itemText) {
              lines.push(`${prefix}- **${itemText}** — ${descText}`);
            }
          }
        }
        break;
      }

      case "mapping": {
        lines.push(`${prefix}**Mapping:**`);
        for (const child of node.children ?? []) {
          if (child.type === "element" && child.tag === "group") {
            const members = (child.children ?? []).filter(
              (c) => c.type === "element" && c.tag === "member",
            );
            const texts = (child.children ?? []).filter(
              (c) => c.type === "element" && c.tag === "text",
            );
            for (const m of members) {
              const idx = (m.children ?? [])
                .filter((c) => c.type === "element" && c.tag === "index")
                .map((c) => renderInline(c.children ?? []).trim())
                .join("");
              const mtype = (m.children ?? [])
                .filter((c) => c.type === "element" && c.tag === "type")
                .map(renderType)
                .join("");
              const desc = texts
                .flatMap((t) => (t.children ?? []).filter((c) => c.type === "element" && c.tag === "p"))
                .map((p) => renderInline(p.children ?? []).trim())
                .filter(Boolean)
                .join(" ");
              lines.push(`${prefix}  - ${idx}: ${mtype} — ${desc}`);
            }
          }
        }
        break;
      }

      case "array": {
        lines.push(`${prefix}**Array:**`);
        for (const child of node.children ?? []) {
          if (child.type === "element" && child.tag === "group") {
            const elems = (child.children ?? []).filter(
              (c) => c.type === "element" && c.tag === "elem",
            );
            const texts = (child.children ?? []).filter(
              (c) => c.type === "element" && c.tag === "text",
            );
            for (const e of elems) {
              const idx = e.attrs?.["name"] ?? (e.children ?? [])
                .filter((c) => c.type === "element" && c.tag === "index")
                .map((c) => renderInline(c.children ?? []).trim())
                .join("");
              const etype = (e.children ?? [])
                .filter((c) => c.type === "element" && c.tag === "type")
                .map(renderType)
                .join("");
              const desc = texts
                .flatMap((t) => (t.children ?? []).filter((c) => c.type === "element" && c.tag === "p"))
                .map((p) => renderInline(p.children ?? []).trim())
                .filter(Boolean)
                .join(" ");
              lines.push(`${prefix}  - \`${idx}\`: ${etype} — ${desc}`);
            }
          }
        }
        break;
      }

      case "multiset": {
        lines.push(`${prefix}**Multiset:**`);
        for (const child of node.children ?? []) {
          if (child.type === "element" && child.tag === "group") {
            const indices = (child.children ?? []).filter(
              (c) => c.type === "element" && c.tag === "index",
            );
            const texts = (child.children ?? []).filter(
              (c) => c.type === "element" && c.tag === "text",
            );
            for (const idx of indices) {
              const name = renderInline(idx.children ?? []).trim();
              const desc = texts
                .flatMap((t) => (t.children ?? []).filter((c) => c.type === "element" && c.tag === "p"))
                .map((p) => renderInline(p.children ?? []).trim())
                .filter(Boolean)
                .join(" ");
              lines.push(`${prefix}  - \`${name}\` — ${desc}`);
            }
          }
        }
        break;
      }

      case "mixed": {
        for (const child of node.children ?? []) {
          if (child.type === "element" && child.tag === "group") {
            const typeNodes = (child.children ?? []).filter(
              (c) => c.type === "element" && c.tag === "type",
            );
            const typeStr = typeNodes.map(renderType).join(" | ");
            const texts = (child.children ?? []).filter(
              (c) => c.type === "element" && c.tag === "text",
            );
            const desc = texts
              .flatMap((t) => (t.children ?? []).filter((c) => c.type === "element" && c.tag === "p"))
              .map((p) => renderInline(p.children ?? []).trim())
              .filter(Boolean)
              .join(" ");
            if (typeStr) {
              lines.push(`${prefix}  - \`${typeStr}\` — ${desc}`);
            }
          }
        }
        break;
      }

      case "string": {
        if (node.children && node.children.length > 0) {
          const hasValueGroups = (node.children ?? []).some(
            (c) => c.type === "element" && c.tag === "group" &&
              (c.children ?? []).some((gc) => gc.type === "element" && gc.tag === "value"),
          );
          if (hasValueGroups) {
            for (const child of node.children ?? []) {
              if (child.type === "element" && child.tag === "group") {
                const values = (child.children ?? []).filter(
                  (c) => c.type === "element" && c.tag === "value",
                );
                const valStr = values.map((v) => renderInline(v.children ?? []).trim()).join("");
                const texts = (child.children ?? []).filter(
                  (c) => c.type === "element" && c.tag === "text",
                );
                const desc = texts
                  .flatMap((t) => (t.children ?? []).filter((c) => c.type === "element" && c.tag === "p"))
                  .map((p) => renderInline(p.children ?? []).trim())
                  .filter(Boolean)
                  .join(" ");
                if (valStr) {
                  lines.push(`${prefix}  - \`${valStr}\` — ${desc}`);
                }
              }
            }
          }
        }
        break;
      }

      case "value": {
        const content = renderInline(node.children ?? []).trim();
        if (content) lines.push(`${prefix}\`${content}\``);
        break;
      }

      case "ol": {
        let idx = 0;
        for (const child of node.children ?? []) {
          if (child.type === "element" && child.tag === "li") {
            const text = renderInline(child.children ?? []).trim();
            if (text) lines.push(`${prefix}${++idx}. ${text}`);
          }
        }
        if (idx > 0) lines.push("");
        break;
      }

      case "ul": {
        for (const child of node.children ?? []) {
          if (child.type === "element" && child.tag === "li") {
            const text = renderInline(child.children ?? []).trim();
            if (text) lines.push(`${prefix}- ${text}`);
          }
        }
        break;
      }

      case "section": {
        const title = node.attrs?.["title"] ?? "";
        if (title) lines.push(`${prefix}### ${title}`);
        lines.push(...renderBlocks(node.children ?? [], indent));
        break;
      }

      case "source-position":
        break;

      case "doc": {
        for (const child of node.children ?? []) {
          if (child.type === "element") {
            if (child.tag === "text") {
              lines.push(...renderBlocks([child], indent));
            } else if (child.tag === "group") {
              lines.push(...renderDocGroup(child));
            } else {
              lines.push(...renderBlocks([child], indent));
            }
          }
        }
        break;
      }

      case "param":
        break;

      case "returns":
      case "throws":
        break;

      case "code": {
        const codeText = renderBlocks(node.children ?? [], indent);
        if (codeText.length > 0) {
          lines.push(`${prefix}\`\`\`pike`);
          lines.push(...codeText);
          lines.push(`${prefix}\`\`\``);
        }
        break;
      }

      default: {
        const childText = renderInline(node.children ?? []).trim();
        if (childText) lines.push(prefix + childText);
        break;
      }
    }
  }

  return lines;
}

/** Render a <group> element (param, returns, throws, note, etc.). */
export function renderDocGroup(group: XmlNode): string[] {
  const lines: string[] = [];
  const children = group.children ?? [];

  const markerEl = children.find(
    (c) => c.type === "element" && ["param", "returns", "throws", "note", "deprecated", "seealso", "example", "bugs"].includes(c.tag ?? ""),
  );

  if (!markerEl) {
    lines.push(...renderBlocks(children));
    return lines;
  }

  const groupType = markerEl.tag;

  const textEls = children.filter((c) => c.type === "element" && c.tag === "text");
  const descParas = textEls
    .flatMap((t) => (t.children ?? []).filter((c) => c.type === "element" && c.tag === "p"))
    .map((p) => renderInline(p.children ?? []).trim())
    .filter(Boolean);
  const desc = descParas.join("\n\n");

  switch (groupType) {
    case "param": {
      const name = markerEl.attrs?.["name"] ?? "";
      lines.push(`- \`${name}\` — ${desc || "(no description)"}`);
      const blockChildren = textEls.flatMap(
        (t) => (t.children ?? []).filter((c) => c.type === "element" && c.tag !== "p"),
      );
      if (blockChildren.length > 0) {
        lines.push(...renderBlocks(blockChildren, 1));
      }
      break;
    }
    case "returns":
      lines.push(`**Returns:** ${desc || ""}`);
      break;
    case "throws":
      lines.push(`**Throws:** ${desc || ""}`);
      break;
    case "note":
      lines.push(`**Note:** ${desc}`);
      break;
    case "seealso":
      lines.push(`**See also:** ${desc}`);
      break;
    case "bugs":
      lines.push(`**Bugs:** ${desc}`);
      break;
    case "deprecated":
      lines.push(`**Deprecated:** ${desc || "No longer recommended."}`);
      break;
    case "example":
      lines.push(`**Example:** ${desc}`);
      break;
    default:
      if (desc) lines.push(desc);
      break;
  }

  return lines;
}
