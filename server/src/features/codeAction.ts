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

/** Matcher function: returns true if this diagnostic should trigger an action. */
type DiagnosticMatcher = (diag: Diagnostic) => boolean;

/** Edit producer: given a diagnostic, returns text edits. */
type EditProducer = (diag: Diagnostic, text: string) => TextEdit[];

/** A registered quick-fix. */
interface QuickFix {
  title: string;
  match: DiagnosticMatcher;
  produceEdits: EditProducer;
  kind: string;
}

// ---------------------------------------------------------------------------
// Built-in quick-fixes
// ---------------------------------------------------------------------------

/** Match Pike compiler "Unused local variable" warning. */
const MATCH_UNUSED_LOCAL: DiagnosticMatcher = (diag) =>
  diag.source === "pike" &&
  /^Unused local variable\b/.test(diag.message);

/** Produce edit: delete the line containing the diagnostic. */
function removeUnusedVariableLine(diag: Diagnostic, text: string): TextEdit[] {
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
// Quick-fix registry
// ---------------------------------------------------------------------------

const QUICK_FIXES: QuickFix[] = [
  {
    title: "Remove unused variable",
    match: MATCH_UNUSED_LOCAL,
    produceEdits: removeUnusedVariableLine,
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
): CodeAction[] {
  const actions: CodeAction[] = [];

  const diagnostics = params.context.diagnostics;
  const uri = params.textDocument.uri;

  for (const diag of diagnostics) {
    for (const fix of QUICK_FIXES) {
      if (fix.match(diag)) {
        const edits = fix.produceEdits(diag, text);
        if (edits.length > 0) {
          const changes: Record<string, TextEdit[]> = {};
          changes[uri] = edits;

          const workspaceEdit: WorkspaceEdit = { changes };

          actions.push({
            title: fix.title,
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
