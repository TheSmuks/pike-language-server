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

// ---------------------------------------------------------------------------
// Lightweight XML parser
// ---------------------------------------------------------------------------

export interface XmlNode {
  type: "element" | "text";
  tag?: string;
  attrs?: Record<string, string>;
  children?: XmlNode[];
  text?: string;
}

/**
 * Parse a well-formed XML string into a tree of XmlNodes.
 *
 * Handles: elements, attributes, self-closing tags, text content, CDATA,
 * XML entities (&amp; &lt; &gt; &quot; &apos; &#NNN;).
 * Skips: processing instructions (<?...?>), comments (<!--...-->).
 */
export function parseXml(xml: string): XmlNode {
  let pos = 0;

  function skipWhitespace(): void {
    while (pos < xml.length && /\s/.test(xml[pos])) pos++;
  }

  function decodeEntities(s: string): string {
    return s
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  }

  function parseName(): string {
    const start = pos;
    while (pos < xml.length && /[\w:.\-]/.test(xml[pos])) pos++;
    return xml.slice(start, pos);
  }

  function parseQuotedValue(): string {
    if (xml[pos] !== '"' && xml[pos] !== "'") return "";
    const quote = xml[pos++];
    const start = pos;
    while (pos < xml.length && xml[pos] !== quote) pos++;
    const value = xml.slice(start, pos);
    pos++; // skip closing quote
    return decodeEntities(value);
  }

  function parseAttrs(): Record<string, string> {
    const attrs: Record<string, string> = {};
    while (pos < xml.length) {
      skipWhitespace();
      if (pos >= xml.length || xml[pos] === ">" || xml[pos] === "/") break;
      const name = parseName();
      if (!name) break;
      skipWhitespace();
      if (xml[pos] === "=") {
        pos++;
        skipWhitespace();
        attrs[name] = parseQuotedValue();
      } else {
        attrs[name] = "";
      }
    }
    return attrs;
  }

  function parseNodes(): XmlNode[] {
    const nodes: XmlNode[] = [];
    while (pos < xml.length) {
      if (xml[pos] === "<") {
        // Skip processing instructions and comments
        if (xml[pos + 1] === "?") {
          const end = xml.indexOf("?>", pos + 2);
          pos = end >= 0 ? end + 2 : xml.length;
          continue;
        }
        if (xml[pos + 1] === "!" && xml.slice(pos, pos + 4) === "<!--") {
          const end = xml.indexOf("-->", pos + 4);
          pos = end >= 0 ? end + 3 : xml.length;
          continue;
        }
        if (xml[pos + 1] === "/") break; // closing tag — return to parent
        nodes.push(parseElement());
      } else {
        nodes.push(parseText());
      }
    }
    return nodes;
  }

  function parseElement(): XmlNode {
    pos++; // skip <
    const tag = parseName();
    const attrs = parseAttrs();
    skipWhitespace();

    // Self-closing?
    if (xml[pos] === "/" && xml[pos + 1] === ">") {
      pos += 2;
      return { type: "element", tag, attrs, children: [] };
    }

    pos++; // skip >

    const children = parseNodes();

    // Consume closing tag
    if (xml[pos] === "<" && xml[pos + 1] === "/") {
      const closeEnd = xml.indexOf(">", pos + 2);
      pos = closeEnd >= 0 ? closeEnd + 1 : xml.length;
    }

    return { type: "element", tag, attrs, children };
  }

  function parseText(): XmlNode {
    const start = pos;
    while (pos < xml.length && xml[pos] !== "<") pos++;
    const text = decodeEntities(xml.slice(start, pos));
    return { type: "text", text };
  }

  const nodes = parseNodes();

  // Return the root element (skip any text nodes before it)
  const root = nodes.find((n) => n.type === "element");
  return root ?? { type: "text", text: "" };
}

// ---------------------------------------------------------------------------
// XML walker: find a docgroup by symbol name
// ---------------------------------------------------------------------------

/** Find the <docgroup> for a named symbol in the XML tree. */
export function findDocGroup(root: XmlNode, symbolName: string): XmlNode | null {
  if (root.type !== "element") return null;

  // Check if this is a <docgroup> matching the symbol
  if (root.tag === "docgroup") {
    const homogenName = root.attrs?.["homogen-name"];
    if (homogenName === symbolName) return root;

    // Also check child <method>, <variable>, <constant>, <class> elements for name match
    for (const child of root.children ?? []) {
      if (child.type === "element" && child.tag !== "doc" && child.tag !== "source-position") {
        if (child.attrs?.["name"] === symbolName) return root;
      }
    }
  }

  // Recurse into children
  for (const child of root.children ?? []) {
    const found = findDocGroup(child, symbolName);
    if (found) return found;
  }

  return null;
}

/** Find a <class> element by name. */
export function findClass(root: XmlNode, className: string): XmlNode | null {
  if (root.type !== "element") return null;

  if (root.tag === "class" && root.attrs?.["name"] === className) {
    // Check if it has a <doc> child
    const hasDoc = (root.children ?? []).some(
      (c) => c.type === "element" && c.tag === "doc",
    );
    if (hasDoc) return root;
  }

  for (const child of root.children ?? []) {
    const found = findClass(child, className);
    if (found) return found;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Type rendering (from <type> subtrees)
// ---------------------------------------------------------------------------

function renderType(node: XmlNode): string {
  if (node.type === "text") return node.text?.trim() ?? "";

  switch (node.tag) {
    case "type":
      return (node.children ?? []).map(renderType).join("");
    case "int": {
      // Check for range constraints
      const children = node.children ?? [];
      const hasRange = children.some((c) => c.type === "element" && (c.tag === "min" || c.tag === "max"));
      if (hasRange) {
        const minEl = children.find((c) => c.type === "element" && c.tag === "min");
        const maxEl = children.find((c) => c.type === "element" && c.tag === "max");
        const minVal = minEl ? (minEl.children ?? []).map((c) => c.text?.trim() ?? "").join("") : "";
        const maxVal = maxEl ? (maxEl.children ?? []).map((c) => c.text?.trim() ?? "").join("") : "";
        if (minVal && maxVal) return `int(${minVal}..${maxVal})`;
      }
      return "int";
    }
    case "string":
      return "string";
    case "float":
      return "float";
    case "void":
      return "void";
    case "mixed":
      return "mixed";
    case "bool":
      return "bool";
    case "zero":
      return "zero";
    case "object": {
      const cls = node.attrs?.["class"] ?? node.children?.map(renderType).join("");
      return cls ? `object(${cls})` : "object";
    }
    case "array": {
      const inner = (node.children ?? [])
        .filter((c) => c.type === "element" && c.tag !== "int" && c.tag !== "string")
        .map(renderType)
        .join("");
      return inner && inner !== "mixed" ? `array(${inner})` : "array";
    }
    case "mapping": {
      const parts = (node.children ?? []).map(renderType);
      if (parts.length >= 2) return `mapping(${parts[0]} : ${parts[1]})`;
      return "mapping";
    }
    case "multiset": {
      const inner = (node.children ?? []).map(renderType).join("");
      return inner ? `multiset(${inner})` : "multiset";
    }
    case "function": {
      const parts = (node.children ?? []).map(renderType);
      if (parts.length >= 2) {
        const args = parts.slice(0, -1).join(", ");
        const ret = parts[parts.length - 1];
        return `function(${args} : ${ret})`;
      }
      return "function";
    }
    case "program": {
      const inner = (node.children ?? []).map(renderType).join("");
      return inner ? `program(${inner})` : "program";
    }
    case "varargs": {
      const inner = (node.children ?? []).map(renderType).join("");
      return `${inner} ...`;
    }
    case "or": {
      const parts = (node.children ?? []).map(renderType);
      return parts.join("|");
    }
    case "optional":
      return (node.children ?? []).map(renderType).join("");
    case "attribute":
      return (node.children ?? []).map(renderType).join("");
    case "indextype":
    case "valuetype":
      return (node.children ?? []).map(renderType).join("");
    case "min":
    case "max":
      return ""; // range limits — skip for hover
    default:
      return (node.children ?? []).map(renderType).join("");
  }
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

/**
 * Extract the method/variable/class signature from its XML element.
 */
function renderSignature(node: XmlNode): string {
  if (node.type !== "element") return "";

  switch (node.tag) {
    case "method": {
      const name = node.attrs?.["name"] ?? "";
      const args: string[] = [];
      const retType: string[] = [];

      for (const child of node.children ?? []) {
        if (child.type === "element") {
          if (child.tag === "arguments") {
            for (const arg of child.children ?? []) {
              if (arg.type === "element" && arg.tag === "argument") {
                const argName = arg.attrs?.["name"] ?? "";
                const argType = (arg.children ?? [])
                  .filter((c) => c.type === "element" && c.tag === "type")
                  .map(renderType)
                  .join("");
                args.push(argType ? `${argType} ${argName}` : argName);
              }
            }
          } else if (child.tag === "returntype") {
            retType.push(renderType(child));
          }
        }
      }

      const ret = retType.join("") || "void";
      const params = args.join(", ");
      return `${ret} ${name}(${params})`;
    }

    case "variable": {
      const name = node.attrs?.["name"] ?? "";
      const varType = (node.children ?? [])
        .filter((c) => c.type === "element" && c.tag === "type")
        .map(renderType)
        .join("");
      return varType ? `${varType} ${name}` : name;
    }

    case "constant": {
      const name = node.attrs?.["name"] ?? "";
      return `constant ${name}`;
    }

    case "inherit": {
      const name = node.attrs?.["name"] ?? "";
      const cls = node.attrs?.["class"] ?? "";
      return cls ? `inherit ${cls} : ${name}` : `inherit ${name}`;
    }

    case "class": {
      const name = node.attrs?.["name"] ?? "";
      return `class ${name}`;
    }

    case "typedef": {
      const name = node.attrs?.["name"] ?? "";
      return `typedef ${name}`;
    }

    default:
      return "";
  }
}

/** Render inline text content (inside <p>, <text>, etc.) to markdown. */
function renderInline(nodes: XmlNode[]): string {
  const parts: string[] = [];

  for (const node of nodes) {
    if (node.type === "text") {
      const t = node.text ?? "";
      // Collapse whitespace in text nodes
      parts.push(t.replace(/\s+/g, " "));
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

      // Cross-references: plain text in v1
      case "ref":
        parts.push(renderInline(node.children ?? []));
        break;

      // Pike expressions — render as inline code
      case "expr":
        parts.push(`\`${renderInline(node.children ?? [])}\``);
        break;

      // Unknown inline element: render children as text
      default:
        parts.push(renderInline(node.children ?? []));
        break;
    }
  }

  return parts.join("");
}

/** Render block-level documentation content to markdown lines. */
function renderBlocks(nodes: XmlNode[], indent = 0): string[] {
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
        if (text) lines.push(prefix + text);
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
        // Also render any block elements inside <text> (mixed, string, dl, etc.)
        const blockChildren = textChildren.flatMap(
          (tc) => (tc.children ?? []).filter(
            (c) => c.type === "element" && c.tag !== "p"
          ),
        );
        if (blockChildren.length > 0) {
          lines.push(...renderBlocks(blockChildren, indent + 1));
        }
        // Also render direct block children of the group (not inside <text>)
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

      // Returns
      case "group": // handled above
        break;

      // Text container
      case "text": {
        const blockChildren = (node.children ?? []).filter(
          (c) => c.type !== "text" || (c.text?.trim() ?? ""),
        );
        lines.push(...renderBlocks(blockChildren, indent));
        break;
      }

      // Deprecated
      case "deprecated": {
        const inner = renderInline(node.children ?? []).trim();
        lines.push(`${prefix}**Deprecated:** ${inner || "No longer recommended."}`);
        break;
      }

      // Notes
      case "note": {
        // note is a delimiter keyword; its content follows in a <group>
        // If it has inline children, render them
        if (node.children && node.children.length > 0) {
          lines.push(`${prefix}**Note:** ${renderInline(node.children).trim()}`);
        }
        break;
      }

      // Bugs
      case "bugs": {
        if (node.children && node.children.length > 0) {
          lines.push(`${prefix}**Bugs:** ${renderInline(node.children).trim()}`);
        }
        break;
      }

      // See also
      case "seealso": {
        if (node.children && node.children.length > 0) {
          lines.push(`${prefix}**See also:** ${renderInline(node.children).trim()}`);
        }
        break;
      }

      // Example (render as code block)
      case "example": {
        const content = renderInline(node.children ?? []).trim();
        if (content) {
          lines.push(`${prefix}\n${prefix}\`\`\`pike`);
          lines.push(...content.split("\n").map((l) => prefix + l));
          lines.push(`${prefix}\`\`\``);
        }
        break;
      }

      // List/description list
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

      // Mapping
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

      // Array
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

      // Multiset
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

      // Mixed type (typed value list, like a type-tagged dl)
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

      // String container (value list, like <mixed> but with <value> instead of <type>)
      case "string": {
        if (node.children && node.children.length > 0) {
          // Check if this is a documentation container (has <group> children with <value>)
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

      // Value element (inline)
      case "value": {
        const content = renderInline(node.children ?? []).trim();
        if (content) lines.push(`${prefix}\`${content}\``);
        break;
      }

      // Section
      case "section": {
        const title = node.attrs?.["title"] ?? "";
        if (title) lines.push(`${prefix}### ${title}`);
        lines.push(...renderBlocks(node.children ?? [], indent));
        break;
      }

      // Source position — skip (not documentation)
      case "source-position":
        break;

      // Structural elements that are containers
      case "doc": {
        // Process children in order: <text> first (summary), then <group> (sections)
        for (const child of node.children ?? []) {
          if (child.type === "element") {
            if (child.tag === "text") {
              // Render all content inside <text>, not just paragraphs
              lines.push(...renderBlocks([child], indent));
            } else if (child.tag === "group") {
              lines.push(...renderDocGroup(child));
            } else {
              // Direct block children (mapping, dl, etc.)
              lines.push(...renderBlocks([child], indent));
            }
          }
        }
        break;
      }

      // Param (standalone — e.g., inside a <group>)
      case "param":
        // Handled at group level
        break;

      case "returns":
      case "throws":
        // These are empty marker elements inside <group>; content is in the following <text>
        break;

      // Code block (@code...@endcode)
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
function renderDocGroup(group: XmlNode): string[] {
  const lines: string[] = [];
  const children = group.children ?? [];

  // Determine group type from its first non-text child
  const markerEl = children.find(
    (c) => c.type === "element" && ["param", "returns", "throws", "note", "deprecated", "seealso", "example", "bugs"].includes(c.tag ?? ""),
  );

  if (!markerEl) {
    // Unknown group structure — render as plain text
    lines.push(...renderBlocks(children));
    return lines;
  }

  const groupType = markerEl.tag;

  // Get description text
  const textEls = children.filter((c) => c.type === "element" && c.tag === "text");
  const desc = textEls
    .flatMap((t) => (t.children ?? []).filter((c) => c.type === "element" && c.tag === "p"))
    .map((p) => renderInline(p.children ?? []).trim())
    .filter(Boolean)
    .join(" ");

  switch (groupType) {
    case "param": {
      const name = markerEl.attrs?.["name"] ?? "";
      lines.push(`- \`${name}\` — ${desc || "(no description)"}`);
      // Render block children from <text> (mixed, string, dl, etc.)
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
