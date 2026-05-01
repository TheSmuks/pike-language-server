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
 */
export function produceCodeActions(
  params: CodeActionParams,
  text: string,
  ctx: CodeActionContext,
): CodeAction[] {
  const actions: CodeAction[] = [];

  const diagnostics = params.context.diagnostics;
  const uri = params.textDocument.uri;

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

  return actions;
}
