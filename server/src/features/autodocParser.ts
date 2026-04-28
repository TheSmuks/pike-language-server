/**
 * AutoDoc parser — extracts structured documentation from Pike //! comments.
 *
 * Pike's AutoDoc syntax uses //! comments preceding declarations.
 * Tree-sitter-pike exposes these as `autodoc_comment` nodes.
 *
 * Architecture: parse-tree + source-text driven, no subprocess calls,
 * no file I/O. The Pike worker is NOT involved in AutoDoc extraction.
 *
 * Hover routing (per decision 0002 + deployment context):
 *   1. Workspace AutoDoc: //! comments from parse tree → markdown
 *   2. Stdlib: pike-ai-kb pike-signature → markdown
 *   3. Fall-through: tree-sitter declared type → bare signature
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutodocBlock {
  /** Summary text (first paragraph). */
  summary: string;
  /** @param entries. */
  params: Array<{ name: string; description: string }>;
  /** @returns text. */
  returns: string;
  /** @throws entries. */
  throws: Array<{ type: string; description: string }>;
  /** @note entries. */
  notes: string[];
  /** @deprecated text (empty string if present without description). */
  deprecated: string | null;
  /** @seealso references. */
  seeAlso: string[];
  /** Raw lines for any unrecognized tags. */
  extra: Array<{ tag: string; text: string }>;
}

// ---------------------------------------------------------------------------
// Source-text AutoDoc extraction
// ---------------------------------------------------------------------------

/**
 * Extract AutoDoc comment lines preceding a declaration at the given line.
 *
 * Works on raw source text — no parse tree needed.
 * Walks backward from targetLine, collecting consecutive //! lines,
 * stopping at the first non-//! line or blank line gap.
 *
 * @param sourceLines The source text split into lines
 * @param targetLine 0-based line of the declaration
 * @returns Raw autodoc text lines (//! prefix stripped)
 */
export function extractAutodocLines(sourceLines: string[], targetLine: number): string[] {
  const result: string[] = [];
  const autodocPrefix = "//!";

  // Walk backward from the line before targetLine
  for (let i = targetLine - 1; i >= 0; i--) {
    const line = sourceLines[i];
    const trimmed = line.trimStart();

    if (trimmed.startsWith(autodocPrefix)) {
      // Strip "//! " prefix
      const text = trimmed.slice(3).trim();
      result.unshift(text);
    } else if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("/*")) {
      // Empty line or non-autodoc comment — continue walking (they may separate
      // autodoc blocks from other code)
      // But stop at blank lines to avoid picking up autodoc from a different declaration
      if (trimmed === "") break;
      continue;
    } else {
      // Non-comment, non-empty line — stop
      break;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// AutoDoc tag parsing
// ---------------------------------------------------------------------------

/**
 * Parse raw AutoDoc text lines into a structured AutodocBlock.
 */
export function parseAutodocLines(lines: string[]): AutodocBlock | null {
  if (lines.length === 0) return null;

  const result: AutodocBlock = {
    summary: "",
    params: [],
    returns: "",
    throws: [],
    notes: [],
    deprecated: null,
    seeAlso: [],
    extra: [],
  };

  let currentSection: "summary" | "param" | "returns" | "throws" | "note" | "other" = "summary";
  let currentParam: { name: string; description: string } | null = null;
  let currentThrow: { type: string; description: string } | null = null;
  let extraTag = "";
  let extraText = "";

  for (const line of lines) {
    // Check for tag
    const tagMatch = line.match(/^@(\w+)\s*(.*)/);
    if (tagMatch) {
      // Flush previous section
      flushCurrent();

      const tag = tagMatch[1];
      const rest = tagMatch[2];

      switch (tag) {
        case "param": {
          const paramMatch = rest.match(/^(\w+)\s*(?:-\s*)?(.*)/);
          if (paramMatch) {
            currentSection = "param";
            currentParam = { name: paramMatch[1], description: paramMatch[2] };
          }
          break;
        }
        case "returns":
        case "return":
          currentSection = "returns";
          result.returns = rest;
          break;
        case "throws":
        case "throw":
          currentSection = "throws";
          const throwMatch = rest.match(/^(\w+)\s*(?:-\s*)?(.*)/);
          if (throwMatch) {
            currentThrow = { type: throwMatch[1], description: throwMatch[2] };
          } else {
            currentThrow = { type: "mixed", description: rest };
          }
          break;
        case "note":
          currentSection = "note";
          result.notes.push(rest);
          break;
        case "deprecated":
          result.deprecated = rest || "";
          currentSection = "other";
          break;
        case "seealso":
          result.seeAlso.push(rest);
          currentSection = "other";
          break;
        case "example":
        case "decl":
        case "member":
        case "bugs":
        case "fixme":
        case "thanks":
        case "section":
          currentSection = "other";
          extraTag = tag;
          extraText = rest;
          break;
        default:
          currentSection = "other";
          extraTag = tag;
          extraText = rest;
          break;
      }
    } else {
      // Continuation line
      const trimmed = line.replace(/^\s+/, "");
      switch (currentSection) {
        case "summary":
          result.summary += (result.summary ? " " : "") + trimmed;
          break;
        case "param":
          if (currentParam) currentParam.description += " " + trimmed;
          break;
        case "returns":
          result.returns += " " + trimmed;
          break;
        case "throws":
          if (currentThrow) currentThrow.description += " " + trimmed;
          break;
        case "note":
          if (result.notes.length > 0) {
            result.notes[result.notes.length - 1] += " " + trimmed;
          }
          break;
        case "other":
          extraText += " " + trimmed;
          break;
      }
    }
  }

  // Flush final section
  flushCurrent();

  return result.summary || result.params.length > 0 || result.returns ? result : null;

  function flushCurrent() {
    if (currentSection === "param" && currentParam) {
      result.params.push(currentParam);
      currentParam = null;
    }
    if (currentSection === "throws" && currentThrow) {
      result.throws.push(currentThrow);
      currentThrow = null;
    }
    if (currentSection === "other" && extraTag) {
      result.extra.push({ tag: extraTag, text: extraText.trim() });
      extraTag = "";
      extraText = "";
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render an AutodocBlock into markdown for LSP hover.
 */
export function renderAutodocMarkdown(
  autodoc: AutodocBlock,
  signature: string,
): string {
  const parts: string[] = [];

  // Signature
  parts.push("```pike");
  parts.push(signature);
  parts.push("```");

  // Summary
  if (autodoc.summary) {
    parts.push("");
    parts.push(autodoc.summary);
  }

  // Deprecated
  if (autodoc.deprecated !== null) {
    parts.push("");
    parts.push("**Deprecated:** " + (autodoc.deprecated || "No longer recommended."));
  }

  // Params
  if (autodoc.params.length > 0) {
    parts.push("");
    parts.push("**Parameters:**");
    for (const p of autodoc.params) {
      parts.push(`- \`${p.name}\` — ${p.description}`);
    }
  }

  // Returns
  if (autodoc.returns) {
    parts.push("");
    parts.push("**Returns:** " + autodoc.returns);
  }

  // Throws
  if (autodoc.throws.length > 0) {
    parts.push("");
    parts.push("**Throws:**");
    for (const t of autodoc.throws) {
      parts.push(`- \`${t.type}\` — ${t.description}`);
    }
  }

  // Notes
  if (autodoc.notes.length > 0) {
    parts.push("");
    for (const n of autodoc.notes) {
      parts.push("**Note:** " + n);
    }
  }

  // See Also
  if (autodoc.seeAlso.length > 0) {
    parts.push("");
    parts.push("**See also:** " + autodoc.seeAlso.join(", "));
  }

  // Extra tags
  for (const e of autodoc.extra) {
    parts.push("");
    parts.push(`**@${e.tag}:** ${e.text}`);
  }

  return parts.join("\n");
}
