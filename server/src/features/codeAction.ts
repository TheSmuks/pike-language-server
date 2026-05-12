/**
 * Code actions — quick-fixes for diagnostics.
 *
 * Produces CodeAction objects for diagnostics reported by the Pike compiler
 * or the parse phase. Each action maps a diagnostic to an edit that resolves
 * the issue.
 *
 * Design: single-feature module, synchronous (no PikeWorker needed).
 * The server handler passes diagnostics from the LSP context; we filter
 * and produce workspace edits.
 */

import type {
  CodeAction,
  CodeActionParams,
  CodeActionKind,
  Diagnostic,
  TextEdit,
  WorkspaceEdit,
} from "vscode-languageserver/node";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context needed by code actions that depend on workspace state. */
export interface CodeActionContext {
  /** Known stdlib top-level module names (e.g., "Stdio", "Array"). */
  stdlibModules: Set<string>;
}

/** Matcher function: returns true if this diagnostic should trigger an action. */
type DiagnosticMatcher = (diag: Diagnostic) => boolean;

/** Edit producer: given a diagnostic and source text, returns text edits. */
type EditProducer = (diag: Diagnostic, text: string, ctx: CodeActionContext) => TextEdit[];

/** A registered quick-fix. */
interface QuickFix {
  title: string | ((diag: Diagnostic, ctx: CodeActionContext) => string);
  match: DiagnosticMatcher;
  produceEdits: EditProducer;
  kind: string;
}

// ---------------------------------------------------------------------------
// Built-in quick-fixes: remove unused variable
// ---------------------------------------------------------------------------

/** Match Pike compiler "Unused local variable" warning. */
const MATCH_UNUSED_LOCAL: DiagnosticMatcher = (diag) =>
  diag.source === "pike" &&
  /^Unused local variable\b/.test(diag.message);

/** Produce edit: delete the line containing the diagnostic. */
function removeUnusedVariableLine(diag: Diagnostic, text: string, _ctx: CodeActionContext): TextEdit[] {
  const line = diag.range.start.line;
  const lines = text.split("\n");

  if (line < 0 || line >= lines.length) return [];

  // Delete from start of this line to start of next line (including newline).
  // If this is the last line, delete from start to end.
  if (line + 1 < lines.length) {
    return [{
      range: {
        start: { line, character: 0 },
        end: { line: line + 1, character: 0 },
      },
      newText: "",
    }];
  }

  // Last line — delete from previous line's newline to end
  return [{
    range: {
      start: { line: line - 1, character: lines[line - 1]?.length ?? 0 },
      end: { line, character: lines[line].length },
    },
    newText: "",
  }];
}

// ---------------------------------------------------------------------------
// Built-in quick-fixes: add missing import
// ---------------------------------------------------------------------------

/** Regex to extract identifier from "Undefined identifier 'X'" messages. */
const UNDEFINED_IDENTIFIER_RE = /^Undefined identifier '([^']+)'/;

/** Match Pike compiler undefined identifier error. */
const MATCH_UNDEFINED_IDENTIFIER: DiagnosticMatcher = (diag) =>
  diag.source === "pike" &&
  UNDEFINED_IDENTIFIER_RE.test(diag.message);

/**
 * Extract the identifier name from an undefined identifier diagnostic.
 * Returns null if the message doesn't match.
 */
function extractUndefinedIdentifier(diag: Diagnostic): string | null {
  const match = UNDEFINED_IDENTIFIER_RE.exec(diag.message);
  if (!match) return null;
  return match[1];
}

/**
 * Find the insertion point for a new import statement.
 * After any existing imports, inherits, or #pike directives.
 * Returns the line number where the import should be inserted.
 */
function findImportInsertionLine(text: string): number {
  const lines = text.split("\n");
  let lastDirectiveLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Skip empty lines and comments before directives
    if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("/*")) {
      continue;
    }

    // #pike directive
    if (trimmed.startsWith("#pike")) {
      lastDirectiveLine = i;
      continue;
    }

    // import statement
    if (trimmed.startsWith("import ")) {
      lastDirectiveLine = i;
      continue;
    }

    // inherit statement
    if (trimmed.startsWith("inherit ")) {
      lastDirectiveLine = i;
      continue;
    }

    // Non-directive, non-comment — stop scanning
    break;
  }

  // Insert after the last directive line, or at line 0 if none found
  return lastDirectiveLine + 1;
}

/** Produce edit: insert import statement at the top of the file. */
function addMissingImport(diag: Diagnostic, text: string, ctx: CodeActionContext): TextEdit[] {
  const identifier = extractUndefinedIdentifier(diag);
  if (!identifier) return [];

  // Check if identifier matches a known stdlib module
  if (!ctx.stdlibModules.has(identifier)) return [];

  const insertLine = findImportInsertionLine(text);
  const insertText = `import ${identifier};\n`;

  return [{
    range: {
      start: { line: insertLine, character: 0 },
      end: { line: insertLine, character: 0 },
    },
    newText: insertText,
  }];
}

// ---------------------------------------------------------------------------
// Quick-fix registry
// ---------------------------------------------------------------------------

const QUICK_FIXES: QuickFix[] = [
  {
    title: "Remove unused variable",
    match: MATCH_UNUSED_LOCAL,
    produceEdits: removeUnusedVariableLine,
    kind: "quickfix",
  },
  {
    title: (diag, ctx) => {
      const identifier = extractUndefinedIdentifier(diag);
      return `Add import ${identifier}`;
    },
    match: MATCH_UNDEFINED_IDENTIFIER,
    produceEdits: addMissingImport,
    kind: "quickfix",
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Produce code actions for the given parameters.
 *
 * Only returns actions for diagnostics that are present in the params context
 * and match a registered quick-fix.
 *
 * Also produces source actions:
 * - source.fixAll: apply all matching quick-fixes in one action
 * - source.organizeImports: sort and deduplicate import statements
 */
export function produceCodeActions(
  params: CodeActionParams,
  text: string,
  ctx: CodeActionContext,

): CodeAction[] {
  const actions: CodeAction[] = [];

  const diagnostics = params.context.diagnostics;
  const uri = params.textDocument.uri;
  const only = params.context.only ?? [];

  // Determine which action kinds to produce
  const wantsQuickFix = only.length === 0 || only.includes("quickfix");
  const wantsFixAll = only.length === 0 || only.includes("source.fixAll");
  const wantsOrganizeImports = only.length === 0 || only.includes("source.organizeImports");
  const wantsRefactor = only.length === 0 || only.includes("refactor.extract");

  // --- Quick fixes (individual) ---
  if (wantsQuickFix) {
    for (const diag of diagnostics) {
      for (const fix of QUICK_FIXES) {
        if (fix.match(diag)) {
          const edits = fix.produceEdits(diag, text, ctx);
          if (edits.length > 0) {
            const changes: Record<string, TextEdit[]> = {};
            changes[uri] = edits;

            const workspaceEdit: WorkspaceEdit = { changes };
            const title = typeof fix.title === "function"
              ? fix.title(diag, ctx)
              : fix.title;

            actions.push({
              title,
              kind: fix.kind,
              diagnostics: [diag],
              edit: workspaceEdit,
            });
          }
        }
      }
    }
  }

  // --- source.fixAll: apply all matching quick-fixes at once ---
  if (wantsFixAll) {
    const allEdits: TextEdit[] = [];
    for (const diag of diagnostics) {
      for (const fix of QUICK_FIXES) {
        if (fix.match(diag)) {
          const edits = fix.produceEdits(diag, text, ctx);
          allEdits.push(...edits);
        }
      }
    }
    if (allEdits.length > 0) {
      const changes: Record<string, TextEdit[]> = {};
      changes[uri] = allEdits;
      actions.push({
        title: "Fix all auto-fixable issues",
        kind: "source.fixAll",
        edit: { changes },
      });
    }
  }

  // --- source.organizeImports: sort and deduplicate imports ---
  if (wantsOrganizeImports) {
    const edits = organizeImports(text);
    if (edits.length > 0) {
      const changes: Record<string, TextEdit[]> = {};
      changes[uri] = edits;
      actions.push({
        title: "Organize imports",
        kind: "source.organizeImports",
        edit: { changes },
      });
    }
  }

  // --- refactor.extract: extract variable ---
  if (wantsRefactor) {
    const extractEdits = extractVariable(params, text);
    if (extractEdits) {
      const changes: Record<string, TextEdit[]> = {};
      changes[uri] = extractEdits.edits;
      actions.push({
        title: `Extract to variable`,
        kind: "refactor.extract.variable",
        edit: { changes },
      });
    }
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Source action: organize imports
// ---------------------------------------------------------------------------

/**
 * Organize imports: sort alphabetically and remove duplicates.
 * Returns TextEdits or empty array if no changes needed.
 */
function organizeImports(text: string): TextEdit[] {
  const lines = text.split("\n");
  const importLines: { line: number; text: string }[] = [];
  let firstImport = -1;
  let lastImport = -1;

  // Collect all import lines and their positions
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("import ")) {
      if (firstImport === -1) firstImport = i;
      lastImport = i;
      importLines.push({ line: i, text: trimmed });
    }
    // Stop at first non-directive, non-comment, non-blank after imports start
    if (firstImport !== -1 && i > lastImport &&
        trimmed !== "" && !trimmed.startsWith("//") && !trimmed.startsWith("/*") &&
        !trimmed.startsWith("import ") && !trimmed.startsWith("inherit ") &&
        !trimmed.startsWith("#pike")) {
      break;
    }
  }

  if (importLines.length <= 1) return [];

  // Sort and deduplicate
  const sorted = [...new Set(importLines.map(i => i.text))].sort();

  // Check if already sorted and deduplicated
  const original = importLines.map(i => i.text);
  if (original.length === sorted.length && original.every((v, i) => v === sorted[i])) {
    return [];
  }

  // Replace the import block
  const edits: TextEdit[] = [];
  // Delete all existing import lines
  for (const { line } of importLines) {
    edits.push({
      range: {
        start: { line, character: 0 },
        end: { line: line + 1, character: 0 },
      },
      newText: "",
    });
  }
  // Insert sorted imports at the first import position
  edits.push({
    range: {
      start: { line: firstImport, character: 0 },
      end: { line: firstImport, character: 0 },
    },
    newText: sorted.join("\n") + "\n",
  });

  return edits;
}

// ---------------------------------------------------------------------------
// Refactor: extract variable
// ---------------------------------------------------------------------------

/**
 * Extract the selected expression into a local variable.
 * Returns null if the selection is empty or not a valid expression.
 */
function extractVariable(
  params: CodeActionParams,
  text: string,
): { edits: TextEdit[]; varName: string } | null {
  const range = params.range;
  // Need a non-empty selection
  if (range.start.line !== range.end.line) return null;
  if (range.start.character === range.end.character) return null;

  const line = range.start.line;
  const lines = text.split("\n");
  if (line >= lines.length) return null;

  const lineText = lines[line];
  const startChar = range.start.character;
  const endChar = range.end.character;

  if (endChar > lineText.length) return null;
  const selectedText = lineText.slice(startChar, endChar).trim();
  if (!selectedText) return null;

  // Don't extract if it's a full statement (ends with ;)
  if (selectedText.endsWith(";")) return null;
  // Don't extract identifiers (too simple to be useful)
  if (/^[a-zA-Z_]\w*$/.test(selectedText)) return null;

  // Generate a variable name from the expression
  const varName = generateVarName(selectedText);

  // Find the enclosing statement start (for insertion point)
  // Walk backward to find the beginning of the statement
  let statementStart = startChar;
  for (let c = startChar - 1; c >= 0; c--) {
    if (lineText[c] === ";") {
      statementStart = c + 1;
      break;
    }
    if (c === 0) statementStart = 0;
  }

  // Compute indentation of the current line
  const indent = lineText.match(/^\s*/)?.[0] ?? "";

  const edits: TextEdit[] = [];

  // Insert the variable declaration before the statement
  edits.push({
    range: {
      start: { line, character: statementStart },
      end: { line, character: statementStart },
    },
    newText: `${indent}${declKeyword(selectedText)} ${varName} = ${selectedText};\n`,
  });

  // Replace the selected expression with the variable name
  edits.push({
    range: {
      start: { line, character: startChar },
      end: { line, character: endChar },
    },
    newText: varName,
  });

  return { edits, varName };
}

/**
 * Generate a variable name from an expression.
 * Uses simple heuristics: function calls → call result, member access → member name, etc.
 */
function generateVarName(expr: string): string {
  // function_call(...) → result
  const callMatch = expr.match(/^([a-zA-Z_]\w*)\s*\(/);
  if (callMatch) return `${callMatch[1]}Result`;

  // obj.member → member
  const memberMatch = expr.match(/\.([a-zA-Z_]\w*)$/);
  if (memberMatch) return memberMatch[1];

  // obj->member → member
  const arrowMatch = expr.match(/->([a-zA-Z_]\w*)$/);
  if (arrowMatch) return arrowMatch[1];

  return "extracted";
}

/**
 * Determine declaration keyword based on expression content.
 * Pike uses `string`, `int`, `mixed`, etc. for typed declarations.
 * Use `mixed` as fallback when type is unknown.
 */
function declKeyword(_expr: string): string {
  // For now, always use mixed. Type inference could be added later.
  return "mixed";
}
