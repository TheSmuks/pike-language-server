/**
 * Lightweight //! autodoc → markdown renderer.
 *
 * Used by the Tier 2b fallback in hoverHandler when the PikeExtractor XML
 * cache is not available (cross-file hovers on stdlib sources). Handles the
 * most common Pike AutoDoc inline markup found in //! comments:
 *
 *   @[Symbol]       → `Symbol`
 *   @b{bold@}       → **bold**
 *   @i{italic@}     → *italic*
 *   @tt{code@}      → `code`
 *   @url{href@}     → href
 *   @seealso        → removed (rendered as "See also:" paragraph header)
 *   @decl           → removed (signature info)
 *   @returns        → **Returns:**
 *   @throws         → **Throws:**
 *   @param name     → - `name`
 *   @note           → **Note:**
 *   @bugs           → **Bugs:**
 *   @deprecated     → **Deprecated:**
 *   @example        → code block
 *   @ignore         → skip block
 *   @endignore      → end skip
 *   @module NAME    → removed (structural directive)
 *   @endmodule       → removed (structural directive)
 *
 * Does NOT attempt to be a full Pike DocParser — only the inline markup
 * that appears in typical //! comments.
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render an array of //! autodoc lines (prefix already stripped) to markdown.
 * Lines are pre-stripped of the //! prefix. Empty strings represent blank //!
 * separator lines.
 */
export function renderAutodocLines(lines: string[]): string {
  const filtered = filterIgnored(lines);
  const paragraphs = splitParagraphs(filtered);
  const rendered = paragraphs.map(renderParagraph);
  return rendered.filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------------------
// Internal: ignore block filtering
// ---------------------------------------------------------------------------

/**
 * Remove lines inside @ignore ... @endignore blocks.
 */
function filterIgnored(lines: string[]): string[] {
  const result: string[] = [];
  let ignoring = false;

  for (const line of lines) {
    if (ignoring) {
      if (/^@endignore\b/.test(line.trim())) {
        ignoring = false;
      }
      continue;
    }

    if (/^@ignore\b/.test(line.trim())) {
      ignoring = true;
      continue;
    }

    result.push(line);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internal: paragraph splitting
// ---------------------------------------------------------------------------

function splitParagraphs(lines: string[]): string[][] {
  const paragraphs: string[][] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (line.length === 0) {
      if (current.length > 0) {
        paragraphs.push(current);
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) paragraphs.push(current);

  return paragraphs;
}

// ---------------------------------------------------------------------------
// Internal: paragraph rendering
// ---------------------------------------------------------------------------

function renderParagraph(lines: string[]): string {
  if (lines.length === 0) return "";

  const first = lines[0].trim();

  // Structural directives — skip entire paragraph
  if (/^@module\b/.test(first) || /^@endmodule\b/.test(first)) {
    return "";
  }

  // @seealso — render as "See also:" with the rest as content
  if (/^@seealso\b/.test(first)) {
    const content = lines.map(l => l.trim()).join(" ")
      .replace(/^@seealso\s*/, "");
    return `**See also:** ${renderInline(content)}`;
  }

  // @deprecated
  if (/^@deprecated\b/.test(first)) {
    const content = lines.map(l => l.trim()).join(" ")
      .replace(/^@deprecated\s*/, "");
    return `**Deprecated:** ${renderInline(content || "No longer recommended.")}`;
  }

  // @note
  if (/^@note\b/.test(first)) {
    const content = lines.map(l => l.trim()).join(" ")
      .replace(/^@note\s*/, "");
    return `**Note:** ${renderInline(content)}`;
  }

  // @bugs
  if (/^@bugs\b/.test(first)) {
    const content = lines.map(l => l.trim()).join(" ")
      .replace(/^@bugs\s*/, "");
    return `**Bugs:** ${renderInline(content)}`;
  }

  // @returns
  if (/^@returns?\b/.test(first)) {
    const content = lines.map(l => l.trim()).join(" ")
      .replace(/^@returns?\s*/, "");
    return `**Returns:** ${renderInline(content)}`;
  }

  // @throws
  if (/^@throws?\b/.test(first)) {
    const content = lines.map(l => l.trim()).join(" ")
      .replace(/^@throws?\s*/, "");
    return `**Throws:** ${renderInline(content)}`;
  }

  // @param — render as parameter list item
  if (/^@param\b/.test(first)) {
    const content = lines.map(l => l.trim()).join(" ")
      .replace(/^@param\s+/, "");
    const spaceIdx = content.indexOf(" ");
    if (spaceIdx > 0) {
      const name = content.slice(0, spaceIdx);
      const desc = content.slice(spaceIdx + 1);
      return `- \`${name}\` — ${renderInline(desc)}`;
    }
    return `- \`${content}\``;
  }

  // @decl — skip (signature information already shown in code fence)
  if (/^@decl\b/.test(first)) {
    return "";
  }

  // @example — render as code block
  if (/^@example\b/.test(first)) {
    const content = lines.map(l => l.trim()).join("\n")
      .replace(/^@example\s*/, "");
    // Code blocks are inherently safe — VSCode renders them as-is.
    // But strip any trailing backtick triple to avoid breaking the fence.
    const safe = content.replace(/```/g, "`` ");
    return `\`\`\`pike\n${safe}\n\`\`\``;
  }

  // Default: join lines, render inline markup
  const text = lines.join(" ");
  return renderInline(text);
}

// ---------------------------------------------------------------------------
// Internal: inline markup rendering
// ---------------------------------------------------------------------------

/**
 * Render Pike AutoDoc inline markup to markdown.
 */
function renderInline(text: string): string {
  // Sanitize first: escape HTML entities in raw text so user-written
  // doc comments cannot inject HTML or break markdown rendering.
  let result = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // @[Symbol] → `Symbol`
  result = result.replace(/@\[([^\]]+)\]/g, (_, sym: string) => {
    return "`" + sym.replace(/`/g, "\\`") + "`";
  });

  // @b{bold@} → **bold**
  result = result.replace(/@b\{([^@]*)@\}/g, (_, content: string) => {
    return "**" + content.replace(/\*/g, "\\*") + "**";
  });

  // @i{italic@} → *italic*
  result = result.replace(/@i\{([^@]*)@\}/g, (_, content: string) => {
    return "*" + content.replace(/\*/g, "\\*") + "*";
  });

  // @tt{code@} → `code`
  result = result.replace(/@tt\{([^@]*)@\}/g, (_, content: string) => {
    return "`" + content.replace(/`/g, "\\`") + "`";
  });

  // @url{URL@} → URL
  result = result.replace(/@url\{([^@]*)@\}/g, "$1");

  // @rfc{NNNN@} → RFC NNNN
  result = result.replace(/@rfc\{([^@]*)@\}/g, "RFC $1");

  return result;
}
