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
// Mutable parse state (avoids closure capture in extracted helpers)
// ---------------------------------------------------------------------------

interface XmlParseState {
  xml: string;
  pos: number;
}

function skipWhitespace(s: XmlParseState): void {
  while (s.pos < s.xml.length && /\s/.test(s.xml[s.pos])) s.pos++;
}

function decodeEntities(str: string): string {
  return str
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function parseName(s: XmlParseState): string {
  const start = s.pos;
  while (s.pos < s.xml.length && /[\w:.\-]/.test(s.xml[s.pos])) s.pos++;
  return s.xml.slice(start, s.pos);
}

function parseQuotedValue(s: XmlParseState): string {
  if (s.xml[s.pos] !== '"' && s.xml[s.pos] !== "'") return "";
  const quote = s.xml[s.pos++];
  const start = s.pos;
  while (s.pos < s.xml.length && s.xml[s.pos] !== quote) s.pos++;
  const value = s.xml.slice(start, s.pos);
  s.pos++; // skip closing quote
  return decodeEntities(value);
}

function parseAttrs(s: XmlParseState): Record<string, string> {
  const attrs: Record<string, string> = {};
  while (s.pos < s.xml.length) {
    skipWhitespace(s);
    if (s.pos >= s.xml.length || s.xml[s.pos] === ">" || s.xml[s.pos] === "/") break;
    const name = parseName(s);
    if (!name) break;
    skipWhitespace(s);
    if (s.xml[s.pos] === "=") {
      s.pos++;
      skipWhitespace(s);
      attrs[name] = parseQuotedValue(s);
    } else {
      attrs[name] = "";
    }
  }
  return attrs;
}

function parseNodes(s: XmlParseState): XmlNode[] {
  const nodes: XmlNode[] = [];
  while (s.pos < s.xml.length) {
    if (s.xml[s.pos] === "<") {
      if (s.xml[s.pos + 1] === "?") {
        const end = s.xml.indexOf("?>", s.pos + 2);
        s.pos = end >= 0 ? end + 2 : s.xml.length;
        continue;
      }
      if (s.xml[s.pos + 1] === "!" && s.xml.slice(s.pos, s.pos + 4) === "<!--") {
        const end = s.xml.indexOf("-->", s.pos + 4);
        s.pos = end >= 0 ? end + 3 : s.xml.length;
        continue;
      }
      if (s.xml[s.pos + 1] === "/") break; // closing tag — return to parent
      nodes.push(parseElement(s));
    } else {
      nodes.push(parseText(s));
    }
  }
  return nodes;
}

function parseElement(s: XmlParseState): XmlNode {
  s.pos++; // skip <
  const tag = parseName(s);
  const attrs = parseAttrs(s);
  skipWhitespace(s);

  // Self-closing?
  if (s.xml[s.pos] === "/" && s.xml[s.pos + 1] === ">") {
    s.pos += 2;
    return { type: "element", tag, attrs, children: [] };
  }

  s.pos++; // skip >
  const children = parseNodes(s);

  // Consume closing tag
  if (s.xml[s.pos] === "<" && s.xml[s.pos + 1] === "/") {
    const closeEnd = s.xml.indexOf(">", s.pos + 2);
    s.pos = closeEnd >= 0 ? closeEnd + 1 : s.xml.length;
  }

  return { type: "element", tag, attrs, children };
}

function parseText(s: XmlParseState): XmlNode {
  const start = s.pos;
  while (s.pos < s.xml.length && s.xml[s.pos] !== "<") s.pos++;
  return { type: "text", text: decodeEntities(s.xml.slice(start, s.pos)) };
}

// ---------------------------------------------------------------------------
// XML parser entry point
// ---------------------------------------------------------------------------

/**
 * Parse a well-formed XML string into a tree of XmlNodes.
 *
 * Handles: elements, attributes, self-closing tags, text content, CDATA,
 * XML entities (&amp; &lt; &gt; &quot; &apos;).
 * Skips: processing instructions (<?...?>), comments (<!--...-->).
 */
export function parseXml(xml: string): XmlNode {
  const state: XmlParseState = { xml, pos: 0 };
  const nodes = parseNodes(state);
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

