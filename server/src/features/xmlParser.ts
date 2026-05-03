/**
 * Lightweight XML parser and tree walker.
 *
 * Handles: elements, attributes, self-closing tags, text content, CDATA,
 * XML entities (&amp; &lt; &gt; &quot; &apos; &#NNN;).
 * Skips: processing instructions (<?...?>), comments (<!--...-->).
 */

// ---------------------------------------------------------------------------
// XML node type
// ---------------------------------------------------------------------------

export interface XmlNode {
  type: "element" | "text";
  tag?: string;
  attrs?: Record<string, string>;
  children?: XmlNode[];
  text?: string;
}

// ---------------------------------------------------------------------------
// XML parser
// ---------------------------------------------------------------------------

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
// XML walker: find elements by name
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


// Re-export for backward compatibility
export { renderType, renderSignature, renderInline, renderBlocks } from './xml-renderer';

