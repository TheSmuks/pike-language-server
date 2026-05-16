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

import { organizeImports, extractVariable } from "./codeActionSourceActions";

// Re-export source actions for backward compatibility
export { organizeImports, extractVariable };

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
// Built-in quick-fixes: add missing arguments for wrong-arity calls
// ---------------------------------------------------------------------------

/**
 * Regex to extract function name, expected, and actual argument counts
 * from Pike "Wrong number of arguments" messages.
 */
const WRONG_ARITY_RE =
  /Wrong number of arguments to (\w+)\(\)(?:\.?\s*Expected\s+(\d+),?\s*got\s+(\d+))?/;

/**
 * Fallback regex for messages that use the "Expected N, got M" format
 * without the "Wrong number of arguments" prefix.
 */
const EXPECTED_GOT_RE = /Expected\s+(\d+),?\s*got\s+(\d+)/;

/** Match Pike compiler wrong-arity error. */
const MATCH_WRONG_ARITY: DiagnosticMatcher = (diag) =>
  diag.source === "pike" &&
  (WRONG_ARITY_RE.test(diag.message) || EXPECTED_GOT_RE.test(diag.message));

/** Parsed arity information from a diagnostic message. */
interface ArityInfo {
  functionName: string;
  expected: number;
  actual: number;
}

/**
 * Extract arity information from a wrong-arguments diagnostic.
 * Returns null if the message cannot be parsed or counts are missing.
 */
function extractArityInfo(diag: Diagnostic): ArityInfo | null {
  const match = WRONG_ARITY_RE.exec(diag.message);
  if (match) {
    const functionName = match[1];
    if (match[2] !== undefined && match[3] !== undefined) {
      return {
        functionName,
        expected: parseInt(match[2], 10),
        actual: parseInt(match[3], 10),
      };
    }
    // "Wrong number of arguments to foo()" without counts — try fallback
    const fallback = EXPECTED_GOT_RE.exec(diag.message);
    if (fallback) {
      return {
        functionName,
        expected: parseInt(fallback[1], 10),
        actual: parseInt(fallback[2], 10),
      };
    }
    // No counts available — cannot produce a fix
    return null;
  }

  // Bare "Expected N, got M" without function name
  const bareMatch = EXPECTED_GOT_RE.exec(diag.message);
  if (bareMatch) {
    return {
      functionName: "function",
      expected: parseInt(bareMatch[1], 10),
      actual: parseInt(bareMatch[2], 10),
    };
  }

  return null;
}

/**
 * Find the position of the closing `)` for the function call on the
 * diagnostic line. Handles one level of nested parentheses.
 * Returns null if not found.
 */
function findClosingParen(lineText: string, openPos: number): number | null {
  let depth = 0;
  for (let i = openPos; i < lineText.length; i++) {
    const ch = lineText[i];
    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

/**
 * Produce edit: insert placeholder arguments for missing parameters.
 */
function fixArityMismatch(
  diag: Diagnostic,
  text: string,
  _ctx: CodeActionContext,
): TextEdit[] {
  const info = extractArityInfo(diag);
  if (!info) return [];

  // Too many arguments — ambiguous which to remove, produce no edit.
  if (info.actual > info.expected) return [];

  const missingCount = info.expected - info.actual;
  if (missingCount === 0) return [];

  const lineIndex = diag.range.start.line;
  const lines = text.split("\n");
  if (lineIndex < 0 || lineIndex >= lines.length) return [];

  const lineText = lines[lineIndex];

  // Find the function call's opening `(` on this line.
  const funcPattern = info.functionName + "(";
  const funcPos = lineText.indexOf(funcPattern);
  if (funcPos === -1) return [];

  const openParenPos = funcPos + info.functionName.length;
  const closeParenPos = findClosingParen(lineText, openParenPos);
  if (closeParenPos === null) return [];

  // Build the insertion text: ", mixed" repeated for each missing argument.
  const placeholders = ", mixed".repeat(missingCount);

  return [{
    range: {
      start: { line: lineIndex, character: closeParenPos },
      end: { line: lineIndex, character: closeParenPos },
    },
    newText: placeholders,
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
  {
    title: (diag, _ctx) => {
      const info = extractArityInfo(diag);
      if (!info) return "Fix argument count";
      if (info.actual > info.expected) {
        return `Remove ${info.actual - info.expected} extra argument(s)`;
      }
      return `Add ${info.expected - info.actual} missing argument(s) to ${info.functionName}`;
    },
    match: MATCH_WRONG_ARITY,
    produceEdits: fixArityMismatch,
    kind: "quickfix",
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Produce code actions for the given parameters.
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
    collectQuickFixActions(diagnostics, text, ctx, uri, actions);
  }

  // --- source.fixAll: apply all matching quick-fixes at once ---
  if (wantsFixAll) {
    collectFixAllActions(diagnostics, text, ctx, uri, actions);
  }

  // --- source.organizeImports: sort and deduplicate imports ---
  if (wantsOrganizeImports) {
    collectOrganizeImportsAction(text, uri, actions);
  }

  // --- refactor.extract: extract variable ---
  if (wantsRefactor) {
    collectExtractVariableAction(params, text, uri, actions);
  }

  return actions;
}

/** Collect individual quick-fix actions for each matching diagnostic. */
function collectQuickFixActions(
  diagnostics: Diagnostic[],
  text: string,
  ctx: CodeActionContext,
  uri: string,
  actions: CodeAction[],
): void {
  for (const diag of diagnostics) {
    for (const fix of QUICK_FIXES) {
      if (fix.match(diag)) {
        const edits = fix.produceEdits(diag, text, ctx);
        if (edits.length > 0) {
          actions.push(buildQuickFixAction(fix, diag, edits, uri, ctx));
        }
      }
    }
  }
}

/** Build a single CodeAction for a quick-fix match. */
function buildQuickFixAction(
  fix: QuickFix,
  diag: Diagnostic,
  edits: TextEdit[],
  uri: string,
  ctx: CodeActionContext,
): CodeAction {
  const changes: Record<string, TextEdit[]> = {};
  changes[uri] = edits;

  const workspaceEdit: WorkspaceEdit = { changes };
  const title = typeof fix.title === "function"
    ? fix.title(diag, ctx)
    : fix.title;

  return {
    title,
    kind: fix.kind,
    diagnostics: [diag],
    edit: workspaceEdit,
  };
}

/** Collect a single fix-all action combining all matching quick-fixes. */
function collectFixAllActions(
  diagnostics: Diagnostic[],
  text: string,
  ctx: CodeActionContext,
  uri: string,
  actions: CodeAction[],
): void {
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

/** Collect an organize-imports action if there are edits. */
function collectOrganizeImportsAction(
  text: string,
  uri: string,
  actions: CodeAction[],
): void {
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

/** Collect an extract-variable action if applicable. */
function collectExtractVariableAction(
  params: CodeActionParams,
  text: string,
  uri: string,
  actions: CodeAction[],
): void {
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
