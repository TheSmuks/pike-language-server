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
      case "p": renderP(node, lines); break;
      case "group": renderGroup(node, prefix, lines); break;
      case "text": renderTextContainer(node, lines); break;
      case "deprecated": renderSimpleLabel(node, "Deprecated", prefix, lines); break;
      case "note": renderSimpleLabel(node, "Note", prefix, lines); break;
      case "bugs": renderSimpleLabel(node, "Bugs", prefix, lines); break;
      case "seealso": renderSimpleLabel(node, "See also", prefix, lines); break;
      case "example": renderExample(node, prefix, lines); break;
      case "dl": renderDl(node, prefix, lines); break;
      case "mapping": renderMapping(node, prefix, lines); break;
      case "array": renderArrayType(node, prefix, lines); break;
      case "multiset": renderMultiset(node, prefix, lines); break;
      case "mixed": renderMixed(node, prefix, lines); break;
      case "string": renderStringType(node, prefix, lines); break;
      case "value": renderValue(node, prefix, lines); break;
      case "ol": renderOl(node, prefix, lines); break;
      case "ul": renderUl(node, prefix, lines); break;
      case "section": renderSection(node, indent, prefix, lines); break;
      case "doc": renderDoc(node, indent, lines); break;
      case "code": renderCode(node, prefix, lines); break;
      case "source-position": case "param": case "returns": case "throws": break;
      default: renderDefault(node, prefix, lines); break;
    }
  }

  return lines;
}

/** Extract description text from <text><p>...</p></text> children. */
function extractDescFromTextEls(textEls: XmlNode[]): string {
  return textEls
    .flatMap((t) => (t.children ?? []).filter((c) => c.type === "element" && c.tag === "p"))
    .map((p) => renderInline(p.children ?? []).trim())
    .filter(Boolean)
    .join(" ");
}

/** Join paragraph descriptions from text elements with double-newline. */
function joinDescParas(textEls: XmlNode[]): string {
  return textEls
    .flatMap((t) => (t.children ?? []).filter((c) => c.type === "element" && c.tag === "p"))
    .map((p) => renderInline(p.children ?? []).trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Render a <p> paragraph node. */
function renderP(node: XmlNode, lines: string[]): void {
  const text = renderInline(node.children ?? []).trim();
  if (text) lines.push(text);
}

/** Render a <group> parameter group node. */
function renderGroup(node: XmlNode, prefix: string, lines: string[]): void {
  const paramName = (node.children ?? [])
    .filter((c) => c.type === "element" && c.tag === "param")
    .map((c) => c.attrs?.["name"] ?? "")
    .filter(Boolean);
  const textChildren = (node.children ?? []).filter(
    (c) => c.type === "element" && c.tag === "text",
  );
  const desc = extractDescFromTextEls(textChildren);
  if (paramName.length > 0) {
    lines.push(`${prefix}- \`${paramName[0]}\` — ${desc || "(no description)"}`);
  }
  const blockChildren = textChildren.flatMap(
    (tc) => (tc.children ?? []).filter((c) => c.type === "element" && c.tag !== "p"),
  );
  if (blockChildren.length > 0) lines.push(...renderBlocks(blockChildren, 1));
  const directBlocks = (node.children ?? []).filter(
    (c) => c.type === "element" &&
      c.tag !== "param" && c.tag !== "text" && c.tag !== "returns" &&
      c.tag !== "throws" && c.tag !== "note" && c.tag !== "seealso" &&
      c.tag !== "deprecated" && c.tag !== "example" && c.tag !== "bugs",
  );
  if (directBlocks.length > 0) lines.push(...renderBlocks(directBlocks, 1));
}

/** Render a <text> container node. */
function renderTextContainer(node: XmlNode, lines: string[]): void {
  const blockChildren = (node.children ?? []).filter(
    (c) => c.type !== "text" || (c.text?.trim() ?? ""),
  );
  const rendered = renderBlocks(blockChildren, 0);
  if (rendered.length > 0) lines.push(...rendered);
}

/** Render a simple labeled node (deprecated, note, bugs, seealso). */
function renderSimpleLabel(node: XmlNode, label: string, prefix: string, lines: string[]): void {
  if (node.children && node.children.length > 0) {
    const inner = renderInline(node.children).trim();
    const fallback = label === "Deprecated" ? "No longer recommended." : "";
    lines.push(`${prefix}**${label}:** ${inner || fallback}`);
  }
}

/** Render an <example> code block. */
function renderExample(node: XmlNode, prefix: string, lines: string[]): void {
  const content = renderInline(node.children ?? []).trim();
  if (content) {
    // Use indented code block (4-space prefix) to avoid conflicts with
    // triple-backtick sequences inside the example content.
    lines.push(`${prefix}`);
    lines.push(...content.split("\n").map((l) => prefix + "    " + l));
  }
}

/** Render a <dl> definition list. */
function renderDl(node: XmlNode, prefix: string, lines: string[]): void {
  for (const child of node.children ?? []) {
    if (child.type === "element" && child.tag === "group") {
      const items = (child.children ?? []).filter((c) => c.type === "element" && c.tag === "item");
      const texts = (child.children ?? []).filter((c) => c.type === "element" && c.tag === "text");
      const itemText = items.map((i) => i.attrs?.["name"] ?? "").filter(Boolean).join(", ");
      const descText = extractDescFromTextEls(texts);
      if (itemText) lines.push(`${prefix}- **${itemText}** — ${descText}`);
    }
  }
}

/** Render a <mapping> type node. */
function renderMapping(node: XmlNode, prefix: string, lines: string[]): void {
  lines.push(`${prefix}**Mapping:**`);
  for (const child of node.children ?? []) {
    if (child.type === "element" && child.tag === "group") {
      renderMappingGroup(child, prefix, lines);
    }
  }
}

/** Render a single mapping group. */
function renderMappingGroup(group: XmlNode, prefix: string, lines: string[]): void {
  const members = (group.children ?? []).filter((c) => c.type === "element" && c.tag === "member");
  const texts = (group.children ?? []).filter((c) => c.type === "element" && c.tag === "text");
  const desc = extractDescFromTextEls(texts);
  for (const m of members) {
    const idx = (m.children ?? [])
      .filter((c) => c.type === "element" && c.tag === "index")
      .map((c) => renderInline(c.children ?? []).trim()).join("");
    const mtype = (m.children ?? [])
      .filter((c) => c.type === "element" && c.tag === "type")
      .map(renderType).join("");
    lines.push(`${prefix}  - ${idx}: ${mtype} — ${desc}`);
  }
}

/** Render an <array> type node. */
function renderArrayType(node: XmlNode, prefix: string, lines: string[]): void {
  lines.push(`${prefix}**Array:**`);
  for (const child of node.children ?? []) {
    if (child.type === "element" && child.tag === "group") {
      renderArrayGroup(child, prefix, lines);
    }
  }
}

/** Render a single array group. */
function renderArrayGroup(group: XmlNode, prefix: string, lines: string[]): void {
  const elems = (group.children ?? []).filter((c) => c.type === "element" && c.tag === "elem");
  const texts = (group.children ?? []).filter((c) => c.type === "element" && c.tag === "text");
  const desc = extractDescFromTextEls(texts);
  for (const e of elems) {
    const idx = e.attrs?.["name"] ?? (e.children ?? [])
      .filter((c) => c.type === "element" && c.tag === "index")
      .map((c) => renderInline(c.children ?? []).trim()).join("");
    const etype = (e.children ?? [])
      .filter((c) => c.type === "element" && c.tag === "type")
      .map(renderType).join("");
    lines.push(`${prefix}  - \`${idx}\`: ${etype} — ${desc}`);
  }
}

/** Render a <multiset> type node. */
function renderMultiset(node: XmlNode, prefix: string, lines: string[]): void {
  lines.push(`${prefix}**Multiset:**`);
  for (const child of node.children ?? []) {
    if (child.type === "element" && child.tag === "group") {
      renderMultisetGroup(child, prefix, lines);
    }
  }
}

/** Render a single multiset group. */
function renderMultisetGroup(group: XmlNode, prefix: string, lines: string[]): void {
  const indices = (group.children ?? []).filter((c) => c.type === "element" && c.tag === "index");
  const texts = (group.children ?? []).filter((c) => c.type === "element" && c.tag === "text");
  const desc = extractDescFromTextEls(texts);
  for (const idx of indices) {
    const name = renderInline(idx.children ?? []).trim();
    lines.push(`${prefix}  - \`${name}\` — ${desc}`);
  }
}

/** Render a <mixed> type node. */
function renderMixed(node: XmlNode, prefix: string, lines: string[]): void {
  for (const child of node.children ?? []) {
    if (child.type === "element" && child.tag === "group") {
      const typeNodes = (child.children ?? []).filter((c) => c.type === "element" && c.tag === "type");
      const typeStr = typeNodes.map(renderType).join(" | ");
      const texts = (child.children ?? []).filter((c) => c.type === "element" && c.tag === "text");
      const desc = extractDescFromTextEls(texts);
      if (typeStr) lines.push(`${prefix}  - \`${typeStr}\` — ${desc}`);
    }
  }
}

/** Render a <string> type node. */
function renderStringType(node: XmlNode, prefix: string, lines: string[]): void {
  if (!node.children || node.children.length === 0) return;
  const hasValueGroups = node.children.some(
    (c) => c.type === "element" && c.tag === "group" &&
      (c.children ?? []).some((gc) => gc.type === "element" && gc.tag === "value"),
  );
  if (!hasValueGroups) return;
  for (const child of node.children) {
    if (child.type === "element" && child.tag === "group") {
      renderStringGroup(child, prefix, lines);
    }
  }
}

/** Render a single string value group. */
function renderStringGroup(group: XmlNode, prefix: string, lines: string[]): void {
  const values = (group.children ?? []).filter((c) => c.type === "element" && c.tag === "value");
  const valStr = values.map((v) => renderInline(v.children ?? []).trim()).join("");
  const texts = (group.children ?? []).filter((c) => c.type === "element" && c.tag === "text");
  const desc = extractDescFromTextEls(texts);
  if (valStr) lines.push(`${prefix}  - \`${valStr}\` — ${desc}`);
}

/** Render a <value> node. */
function renderValue(node: XmlNode, prefix: string, lines: string[]): void {
  const content = renderInline(node.children ?? []).trim();
  if (content) lines.push(`${prefix}\`${content}\``);
}

/** Render an <ol> ordered list. */
function renderOl(node: XmlNode, prefix: string, lines: string[]): void {
  let idx = 0;
  for (const child of node.children ?? []) {
    if (child.type === "element" && child.tag === "li") {
      const text = renderInline(child.children ?? []).trim();
      if (text) lines.push(`${prefix}${++idx}. ${text}`);
    }
  }
  if (idx > 0) lines.push("");
}

/** Render a <ul> unordered list. */
function renderUl(node: XmlNode, prefix: string, lines: string[]): void {
  for (const child of node.children ?? []) {
    if (child.type === "element" && child.tag === "li") {
      const text = renderInline(child.children ?? []).trim();
      if (text) lines.push(`${prefix}- ${text}`);
    }
  }
}

/** Render a <section> node. */
function renderSection(node: XmlNode, indent: number, prefix: string, lines: string[]): void {
  const title = node.attrs?.["title"] ?? "";
  if (title) lines.push(`${prefix}### ${title}`);
  lines.push(...renderBlocks(node.children ?? [], indent));
}

/** Render a <doc> container node. */
function renderDoc(node: XmlNode, indent: number, lines: string[]): void {
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
}

/** Render a <code> block. */
function renderCode(node: XmlNode, prefix: string, lines: string[]): void {
  const codeText = renderBlocks(node.children ?? [], 0);
  if (codeText.length > 0) {
    lines.push(`${prefix}\`\`\`pike`);
    lines.push(...codeText);
    lines.push(`${prefix}\`\`\``);
  }
}

/** Render default inline fallback. */
function renderDefault(node: XmlNode, prefix: string, lines: string[]): void {
  const childText = renderInline(node.children ?? []).trim();
  if (childText) lines.push(prefix + childText);
}

// ---------------------------------------------------------------------------
// Doc group rendering (shared with renderBlocks)
// ---------------------------------------------------------------------------

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

  const textEls = children.filter((c) => c.type === "element" && c.tag === "text");
  const desc = joinDescParas(textEls);

  renderDocGroupByType(markerEl.tag, markerEl, textEls, desc, lines);
  return lines;
}

/** Dispatch group rendering based on the marker element's tag. */
function renderDocGroupByType(
  groupType: string | undefined,
  markerEl: XmlNode,
  textEls: XmlNode[],
  desc: string,
  lines: string[],
): void {
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
}
