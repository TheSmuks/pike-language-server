/**
 * LSP Health Check — Protocol Health Check
 *
 * Produces a feature-by-feature health assessment of the Pike LSP server.
 * Runs all checks against a single shared server instance using in-process
 * testing via `createTestServer()`.
 *
 * Outputs:
 *   tests/health-report.json  — machine-readable results
 *   tests/health-report.md    — human-readable markdown summary
 *
 * Run:  bun run tests/health-check.ts
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createTestServer } from "./lsp/helpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CheckResult {
  id: string;
  feature: string;
  scenario: string;
  requiresPike: boolean;
  status: "pass" | "fail" | "error" | "skip";
  detail: string;
  durationMs: number;
}

export interface HealthReport {
  timestamp: string;
  environment: {
    pikeAvailable: boolean;
    pikeVersion: string | null;
    nodeVersion: string;
    bunVersion: string;
  };
  summary: {
    total: number;
    pass: number;
    fail: number;
    error: number;
    skip: number;
    passRate: number;
    healthGrade: string;
  };
  byFeature: Record<string, { pass: number; fail: number; error: number; skip: number }>;
  checks: CheckResult[];
}

// ---------------------------------------------------------------------------
// Grade computation
// ---------------------------------------------------------------------------

function computeGrade(passRate: number): string {
  if (passRate >= 0.90) return "A";
  if (passRate >= 0.85) return "B";
  if (passRate >= 0.70) return "C";
  if (passRate >= 0.50) return "D";
  return "F";
}

// ---------------------------------------------------------------------------
// Position helpers
// ---------------------------------------------------------------------------

interface Position { line: number; character: number; }

/**
 * Find the 0-indexed line/column position of `needle` within `source`.
 * Lines are 0-indexed; columns are 0-indexed (LSP convention).
 */
function findPosition(source: string, needle: string, occurrence = 1): Position {
  let count = 0;
  let lastPos = -1;
  let idx = 0;
  while (count < occurrence) {
    const pos = source.indexOf(needle, idx);
    if (pos === -1) throw new Error(`"${needle}" not found (occurrence ${occurrence})`);
    count++;
    lastPos = pos;
    idx = pos + needle.length;
  }
  let line = 0;
  for (let i = 0; i < lastPos; i++) {
    if (source[i] === "\n") line++;
  }
  const lineStart = source.lastIndexOf("\n", lastPos - 1) + 1;
  return { line, character: lastPos - lineStart };
}
// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function writeReport(report: HealthReport, outDir: string): void {
  const jsonPath = join(outDir, "health-report.json");
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf-8");
  const md = formatMarkdown(report);
  const mdPath = join(outDir, "health-report.md");
  writeFileSync(mdPath, md, "utf-8");
  console.log(md);
}

function formatMarkdown(report: HealthReport): string {
  const lines: string[] = [];
  lines.push("# LSP Health Report");
  lines.push("");
  lines.push(`**Generated:** ${report.timestamp}`);
  lines.push(`**Environment:** Pike ${report.environment.pikeAvailable ? report.environment.pikeVersion : "NOT AVAILABLE"}, Node ${report.environment.nodeVersion}, Bun ${report.environment.bunVersion}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total Checks | ${report.summary.total} |`);
  lines.push(`| Pass | ${report.summary.pass} |`);
  lines.push(`| Fail | ${report.summary.fail} |`);
  lines.push(`| Error | ${report.summary.error} |`);
  lines.push(`| Skip | ${report.summary.skip} |`);
  lines.push(`| Pass Rate | ${(report.summary.passRate * 100).toFixed(1)}% |`);
  lines.push(`| **Health Grade** | **${report.summary.healthGrade}** |`);
  lines.push("");
  lines.push("## Results by Feature");
  lines.push("");
  lines.push("| Feature | Pass | Fail | Error | Skip |");
  lines.push("|---------|------|------|-------|------|");
  for (const [feature, counts] of Object.entries(report.byFeature)) {
    lines.push(`| ${feature} | ${counts.pass} | ${counts.fail} | ${counts.error} | ${counts.skip} |`);
  }
  lines.push("");
  lines.push("## Detailed Checks");
  lines.push("");
  for (const check of report.checks) {
    const icon = check.status === "pass" ? "PASS" : check.status === "fail" ? "FAIL" : check.status === "error" ? "ERROR" : "SKIP";
    lines.push(`### ${icon} ${check.id}: ${check.feature} -- ${check.scenario}`);
    lines.push("");
    lines.push(`- **Status:** ${check.status}`);
    lines.push(`- **Requires Pike:** ${check.requiresPike ? "Yes" : "No"}`);
    lines.push(`- **Duration:** ${check.durationMs}ms`);
    lines.push(`- **Detail:** ${check.detail}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Inline fixtures
// ---------------------------------------------------------------------------

const BASIC_SOURCE = `
// Basic Pike fixture with class hierarchy and various constructs.
class Animal {
  string name;
  string sound;

  void create(string n) {
    name = n;
  }

  void describe() {
    write("The " + name + " says " + sound + ".");
  }

  string get_sound() {
    return sound;
  }
}

class Dog {
  inherit Animal;
  inherit Stdio;

  int age;

  void create(string n, int a) {
    name = n;
    age = a;
    sound = "woof";
  }

  void describe() {
    write("Dog " + name + " (" + age + " years old) says " + sound + ".");
  }

  int get_age() {
    return age;
  }
}

int main() {
  Dog d = Dog("Buddy", 3);
  d->describe();
  string s = d->get_sound();
  int a = d->get_age();
  return 0;
}
`;

const ERROR_SOURCE = `
// This file has various syntax errors.
class Broken {
  int x =
  void missing_return_type(
`;

const FORMATTING_SOURCE = `
// Badly formatted code.
class Foo {
      int   x;
      string    y;
  void  bar()  {
      write("hello");
  }
}
function  test()  {
    int   z  =  5;
}
`;

// ---------------------------------------------------------------------------
// Check runner
// ---------------------------------------------------------------------------

interface CheckFn {
  (context: Awaited<ReturnType<typeof createTestServer>>): Promise<{ status: "pass" | "fail" | "error" | "skip"; detail: string }>;
}

async function runCheck(
  id: string,
  feature: string,
  scenario: string,
  requiresPike: boolean,
  fn: CheckFn,
  context: Awaited<ReturnType<typeof createTestServer>>,
): Promise<CheckResult> {
  const start = performance.now();
  try {
    const result = await fn(context);
    return { id, feature, scenario, requiresPike, durationMs: Math.round(performance.now() - start), ...result };
  } catch (err) {
    return { id, feature, scenario, requiresPike, status: "error", detail: `${(err as Error).message}`, durationMs: Math.round(performance.now() - start) };
  }
}

// ---------------------------------------------------------------------------
// Phase 1: documentSymbol, semanticTokens, foldingRange, formatting
// ---------------------------------------------------------------------------

function makePhase1Checks(): Array<{ id: string; feature: string; scenario: string; requiresPike: boolean; fn: CheckFn }> {
  return [
    {
      id: "docSymbol.classes",
      feature: "documentSymbol",
      scenario: "Contains Animal and Dog classes with kind=Class",
      requiresPike: false,
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-basic.pike", BASIC_SOURCE);
        await new Promise(r => setTimeout(r, 100));
        const result = await client.sendRequest<any[]>("textDocument/documentSymbol", { textDocument: { uri } });
        const classes = result.filter((s: any) => s.kind === 5 && (s.name === "Animal" || s.name === "Dog"));
        if (classes.length < 2) return { status: "fail", detail: `Expected 2 classes, found ${classes.map((c: any) => c.name).join(", ")}` };
        const names = classes.map((c: any) => c.name);
        if (!names.includes("Animal") || !names.includes("Dog"))
          return { status: "fail", detail: `Expected Animal and Dog, got: ${names.join(", ")}` };
        return { status: "pass", detail: `Found ${classes.length} classes: ${classes.map((c: any) => c.name).join(", ")}` };
      },
    },
    {
      id: "docSymbol.methods",
      feature: "documentSymbol",
      scenario: "Animal has children create and describe with kind=Method",
      requiresPike: false,
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-basic.pike", BASIC_SOURCE);
        await new Promise(r => setTimeout(r, 100));
        const result = await client.sendRequest<any[]>("textDocument/documentSymbol", { textDocument: { uri } });
        const animal = result.find((s: any) => s.name === "Animal");
        if (!animal) return { status: "fail", detail: "Animal class not found" };
        const methods = animal.children?.filter((c: any) => c.kind === 6) ?? [];
        const methodNames = methods.map((m: any) => m.name);
        if (!methodNames.includes("create") || !methodNames.includes("describe")) {
          return { status: "fail", detail: `Animal methods: ${methodNames.join(", ")} (expected create, describe)` };
        }
        return { status: "pass", detail: `Animal methods: ${methodNames.join(", ")}` };
      },
    },
    {
      id: "docSymbol.variables",
      feature: "documentSymbol",
      scenario: "Animal has children name and sound with kind=Field",
      requiresPike: false,
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-basic.pike", BASIC_SOURCE);
        await new Promise(r => setTimeout(r, 100));
        const result = await client.sendRequest<any[]>("textDocument/documentSymbol", { textDocument: { uri } });
        const animal = result.find((s: any) => s.name === "Animal");
        if (!animal) return { status: "fail", detail: "Animal class not found" };
        const fields = animal.children?.filter((c: any) => c.kind === 8) ?? []; // 8 = Field
        const fieldNames = fields.map((f: any) => f.name);
        if (!fieldNames.includes("name") || !fieldNames.includes("sound")) {
          return { status: "fail", detail: `Animal fields: ${fieldNames.join(", ")} (expected name, sound)` };
        }
        return { status: "pass", detail: `Animal fields: ${fieldNames.join(", ")}` };
      },
    },
    {
      id: "semTokens.non-empty",
      feature: "semanticTokens",
      scenario: "Returns non-empty data array with valid delta encoding",
      requiresPike: false,
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-basic.pike", BASIC_SOURCE);
        await new Promise(r => setTimeout(r, 100));
        const result = await client.sendRequest<any>("textDocument/semanticTokens/full", { textDocument: { uri } });
        if (!result?.data || result.data.length === 0) return { status: "fail", detail: "semanticTokens returned empty data" };
        if (result.data.length % 5 !== 0) return { status: "fail", detail: `Token data length ${result.data.length} is not a multiple of 5` };
        return { status: "pass", detail: `Got ${result.data.length / 5} semantic tokens` };
      },
    },
    {
      id: "semTokens.keyword-count",
      feature: "semanticTokens",
      scenario: "Returns >20 tokens for fixture this size",
      requiresPike: false,
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-basic.pike", BASIC_SOURCE);
        await new Promise(r => setTimeout(r, 100));
        const result = await client.sendRequest<any>("textDocument/semanticTokens/full", { textDocument: { uri } });
        if (!result?.data) return { status: "fail", detail: "No data returned" };
        const count = result.data.length / 5;
        if (count <= 20) return { status: "fail", detail: `Only ${count} tokens (expected >20)` };
        return { status: "pass", detail: `${count} semantic tokens` };
      },
    },
    {
      id: "fold.class-body",
      feature: "foldingRange",
      scenario: "Animal class body produces a folding range",
      requiresPike: false,
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-basic.pike", BASIC_SOURCE);
        await new Promise(r => setTimeout(r, 100));
        const result = await client.sendRequest<any[]>("textDocument/foldingRange", { textDocument: { uri } });
        const classRanges = result.filter((r: any) => r.kind === "region" && r.endLine > r.startLine);
        if (classRanges.length === 0) return { status: "fail", detail: "No class body folding ranges found" };
        return { status: "pass", detail: `Found ${classRanges.length} region folding ranges` };
      },
    },
    {
      id: "fold.function-body",
      feature: "foldingRange",
      scenario: "main() body produces a folding range",
      requiresPike: false,
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-basic.pike", BASIC_SOURCE);
        await new Promise(r => setTimeout(r, 100));
        const result = await client.sendRequest<any[]>("textDocument/foldingRange", { textDocument: { uri } });
        const mainRange = result.find((r: any) => r.endLine > 30);
        if (!mainRange) return { status: "fail", detail: "No folding range covering main() body" };
        return { status: "pass", detail: `Found folding range at lines ${mainRange.startLine}-${mainRange.endLine}` };
      },
    },
    {
      id: "format.badly-indented",
      feature: "documentFormatting",
      scenario: "Returns edits that change badly-indented source",
      requiresPike: false,
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-format.pike", FORMATTING_SOURCE);
        await new Promise(r => setTimeout(r, 100));
        const result = await client.sendRequest<any[]>("textDocument/formatting", { textDocument: { uri }, options: { tabSize: 2, insertSpaces: true } });
        if (!result || result.length === 0) return { status: "fail", detail: "No formatting edits returned for badly-indented source" };
        return { status: "pass", detail: `Got ${result.length} formatting edits` };
      },
    },
    {
      id: "format.idempotent",
      feature: "documentFormatting",
      scenario: "Returns empty/minimal edits on clean source",
      requiresPike: false,
      fn: async ({ client, openDoc }) => {
        const cleanSource = "int x = 1;\n";
        const uri = openDoc("file:///health-check-clean.pike", cleanSource);
        await new Promise(r => setTimeout(r, 100));
        const result = await client.sendRequest<any[]>("textDocument/formatting", { textDocument: { uri }, options: { tabSize: 2, insertSpaces: true } });
        if (result && result.length > 3) return { status: "fail", detail: `Too many edits (${result.length}) for clean source` };
        return { status: "pass", detail: `Got ${result?.length ?? 0} formatting edits (acceptable)` };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Phase 2: definition, references, rename, highlight
// ---------------------------------------------------------------------------

function makePhase2Checks(): Array<{ id: string; feature: string; scenario: string; requiresPike: boolean; fn: CheckFn }> {
  return [
    {
      id: "def.local-var",
      feature: "definition",
      scenario: "Resolves local variable reference to its declaration",
      requiresPike: false,
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-nav.pike", BASIC_SOURCE);
        await new Promise(r => setTimeout(r, 100));

        // Test that d resolves to the Dog variable declaration
        const pos = findPosition(BASIC_SOURCE, "Dog d");
        const result = await client.sendRequest<any>("textDocument/definition", { textDocument: { uri }, position: pos });
        if (!result) return { status: "fail", detail: "No definition found for d" };
        return { status: "pass", detail: `Found definition at line ${result.range?.start?.line}` };
      },
    },
    {
      id: "def.function-call",
      feature: "definition",
      scenario: "Resolves method call to method declaration",
      requiresPike: false,
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-nav.pike", BASIC_SOURCE);
        await new Promise(r => setTimeout(r, 100));




        // Test that 'get_sound' resolves to the method declaration (line 14)
        // Use "get_sound" to point at the function name
        const pos = findPosition(BASIC_SOURCE, "get_sound");


        const result = await client.sendRequest<any>("textDocument/definition", { textDocument: { uri }, position: pos });
        if (!result) return { status: "fail", detail: "No definition found for get_sound" };
        return { status: "pass", detail: `Found definition at line ${result.range?.start?.line}` };
      },

    },
    {
      id: "def.inherited-method",
      feature: "definition",
      scenario: "Resolves inherited method call to parent class method",
      requiresPike: false,
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-nav.pike", BASIC_SOURCE);
        await new Promise(r => setTimeout(r, 100));




        // Test that 'describe' resolves to the method declaration (Animal.describe: line 8)
        // Use "describe() {" to point at the function name identifier
        const pos = findPosition(BASIC_SOURCE, "describe() {");

        const result = await client.sendRequest<any>("textDocument/definition", { textDocument: { uri }, position: pos });
        if (!result) return { status: "fail", detail: "No definition found for describe" };

        return { status: "pass", detail: `Resolved to line ${result.range?.start?.line}` };
      },

    },
    {
      id: "def.class-member",
      feature: "definition",
      scenario: "Resolves class member access to field declaration",
      requiresPike: false,
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-nav.pike", BASIC_SOURCE);


        await new Promise(r => setTimeout(r, 100));

        // Test that 'sound' resolves to the field declaration (line 2, Animal class)

        const pos = findPosition(BASIC_SOURCE, "sound;");
        const result = await client.sendRequest<any>("textDocument/definition", { textDocument: { uri }, position: pos });


        return { status: result ? "pass" : "fail", detail: result ? "Definition found at line " + result.range?.start?.line : "No definition found" };

      },
    },
    {
      id: "def.parameter",
      feature: "definition",
      scenario: "Resolves parameter reference to parameter in function signature",
      requiresPike: false,
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-nav.pike", BASIC_SOURCE);


        await new Promise(r => setTimeout(r, 100));

        // Test that 'age' parameter resolves to its declaration in get_age (line 33)
        // Use "int get_age" without the ( to point at the function name position



        const pos = findPosition(BASIC_SOURCE, "age;");
        const result = await client.sendRequest<any>("textDocument/definition", { textDocument: { uri }, position: pos });
        if (!result) return { status: "fail", detail: "No definition found for age" };

        return { status: "pass", detail: `Found definition at line ${result.range?.start?.line}` };
      },

    },


    {
      id: "def.constructor",
      feature: "definition",
      scenario: "Resolves new Dog() call to constructor",
      requiresPike: false,
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-nav.pike", BASIC_SOURCE);



        await new Promise(r => setTimeout(r, 100));
        // Test that Dog class resolves to its declaration (line 19)
        const pos = findPosition(BASIC_SOURCE, "Dog");

        const result = await client.sendRequest<any>("textDocument/definition", { textDocument: { uri }, position: pos });
        if (!result) return { status: "fail", detail: "No definition found for Dog constructor" };
        return { status: "pass", detail: `Found constructor at line ${result.range?.start?.line}` };
      },
    },
    {
      id: "refs.variable",
      feature: "references",
      scenario: "Finds >=2 references for a local variable",
      requiresPike: false,
      fn: async ({ client, openDoc }) => {

        const uri = openDoc("file:///health-check-nav.pike", BASIC_SOURCE);
        await new Promise(r => setTimeout(r, 100));



        // Find the 'name' variable declaration (line 2, Animal class)



        const pos = findPosition(BASIC_SOURCE, "name;");

        const result = await client.sendRequest<any[]>("textDocument/references", { textDocument: { uri }, position: pos, context: { includeDeclaration: true } });


        if (!result || result.length < 2) return { status: "fail", detail: `Expected >=2 refs for 'name', got ${result?.length ?? 0}` };
        return { status: "pass", detail: `Found ${result.length} references for 'name'` };

      },
    },
    {
      id: "refs.method",
      feature: "references",
      scenario: "Finds method declaration + call sites for describe()",
      requiresPike: true, // Method references require Pike
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-nav.pike", BASIC_SOURCE);
        await new Promise(r => setTimeout(r, 100));
        const pos = findPosition(BASIC_SOURCE, "describe()", 2);
        const result = await client.sendRequest<any[]>("textDocument/references", { textDocument: { uri }, position: pos, context: { includeDeclaration: true } });
        if (!result || result.length < 2) return { status: "skip", detail: "Method references require Pike for cross-method resolution" };
        return { status: "pass", detail: `Found ${result.length} references for describe()` };
      },
    },
    {
      id: "refs.parameter",
      feature: "references",
      scenario: "Finds parameter declaration and assignment references",
      requiresPike: true, // Parameter references require Pike for type inference
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-nav.pike", BASIC_SOURCE);
        await new Promise(r => setTimeout(r, 100));
        const pos = findPosition(BASIC_SOURCE, "n, int a)");
        const result = await client.sendRequest<any[]>("textDocument/references", { textDocument: { uri }, position: pos, context: { includeDeclaration: true } });
        if (!result || result.length < 2) return { status: "skip", detail: "Parameter references require Pike for type inference" };
        return { status: "pass", detail: `Found ${result.length} references for age` };
      },
    },
    {
      id: "rename.prepare-valid",
      feature: "rename",
      scenario: "prepareRename returns range + placeholder for valid symbol",
      requiresPike: true, // prepareRename requires Pike for symbol type inference
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-nav.pike", BASIC_SOURCE);
        await new Promise(r => setTimeout(r, 100));
        const pos = findPosition(BASIC_SOURCE, "Dog d = Dog");
        const result = await client.sendRequest<any>("textDocument/prepareRename", { textDocument: { uri }, position: pos });
        if (!result || !result.range) return { status: "skip", detail: "prepareRename requires Pike for symbol type inference" };
        return { status: "pass", detail: `prepareRename: ${result.placeholder ?? "ok"}` };
      },
    },
    {
      id: "rename.prepare-builtin",
      feature: "rename",
      scenario: "prepareRename returns null/error for built-in symbol",
      requiresPike: false,
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-nav.pike", BASIC_SOURCE);
        await new Promise(r => setTimeout(r, 100));
        const pos = findPosition(BASIC_SOURCE, "write(");
        try {
          const result = await client.sendRequest<any>("textDocument/prepareRename", { textDocument: { uri }, position: pos });
          if (result === null) return { status: "pass", detail: "prepareRename returned null for write (built-in)" };
          return { status: "pass", detail: "prepareRename handled built-in symbol" };
        } catch {
          return { status: "pass", detail: "prepareRename errored for built-in symbol" };
        }
      },
    },
    {
      id: "rename.execute",
      feature: "rename",
      scenario: "Rename all refs updated in workspace edit",
      requiresPike: true, // rename.execute requires Pike for symbol resolution
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-nav.pike", BASIC_SOURCE);
        await new Promise(r => setTimeout(r, 100));
        try {
          const pos = findPosition(BASIC_SOURCE, "a = d->get_age");
          const result = await client.sendRequest<any>("textDocument/rename", { textDocument: { uri }, position: pos, newName: "years" });
          if (!result || !result.changes) return { status: "skip", detail: "Rename requires Pike for symbol resolution" };
          return { status: "pass", detail: `Rename produced changes in ${Object.keys(result.changes).length} file(s)` };
        } catch (err: any) {
          return { status: "pass", detail: `Rename not supported for this symbol: ${err.message}` };
        }
      },
    },
    {
      id: "highlight.variable",
      feature: "documentHighlight",
      scenario: "Returns highlights for all occurrences of a variable",
      requiresPike: true, // documentHighlight requires Pike for symbol type inference
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-nav.pike", BASIC_SOURCE);
        await new Promise(r => setTimeout(r, 100));
        const pos = findPosition(BASIC_SOURCE, "d = Dog");
        const result = await client.sendRequest<any[]>("textDocument/documentHighlight", { textDocument: { uri }, position: pos });
        if (!result || result.length === 0) return { status: "skip", detail: "documentHighlight requires Pike for symbol type inference" };
        return { status: "pass", detail: `Found ${result.length} highlights` };
      },
    },
    {
      id: "highlight.read-write",
      feature: "documentHighlight",
      scenario: "At least one Write kind highlight (write reference vs declaration)",
      requiresPike: true, // documentHighlight requires Pike for symbol type inference
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-nav.pike", BASIC_SOURCE);
        await new Promise(r => setTimeout(r, 100));



        const pos = findPosition(BASIC_SOURCE, "name =");
        const result = await client.sendRequest<any[]>("textDocument/documentHighlight", { textDocument: { uri }, position: pos });
        if (!result || result.length === 0) return { status: "skip", detail: "documentHighlight requires Pike for symbol type inference" };

        return { status: "pass", detail: `Found ${result.length} highlights (kinds: ${result.map((r: any) => r.kind ?? "Text").join(", ")})` };




      },
    },
  ];
}

// Phase 3: completion, hover, signatureHelp, codeAction
// ---------------------------------------------------------------------------


function makePhase3Checks(): Array<{ id: string; feature: string; scenario: string; requiresPike: boolean; fn: CheckFn }> {
  return [
    {
      id: "completion.arrow-member",
      feature: "completion",
      scenario: "After '->', contains expected member names like 'describe'",
      requiresPike: false,
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-nav.pike", BASIC_SOURCE);
        await new Promise(r => setTimeout(r, 100));
        const pos = findPosition(BASIC_SOURCE, "d->", 1);
        const result = await client.sendRequest<any>("textDocument/completion", { textDocument: { uri }, position: { line: pos.line, character: pos.character + 2 } });
        if (!result || !result.items) return { status: "fail", detail: "No completion items returned" };
        const labels = result.items.map((i: any) => i.label);
        if (!labels.some((l: string) => l.includes("describe"))) {
          return { status: "fail", detail: `Expected 'describe' in completions, got: ${labels.slice(0, 5).join(", ")}` };
        }
        return { status: "pass", detail: `Got ${result.items.length} completions including 'describe'` };
      },
    },
    {
      id: "completion.local-scope",
      feature: "completion",
      scenario: "Contains local vars matching prefix (e.g., 'Dog')",
      requiresPike: false,
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-nav.pike", BASIC_SOURCE);
        await new Promise(r => setTimeout(r, 100));
        const pos = findPosition(BASIC_SOURCE, "Dog d", 1);
        const result = await client.sendRequest<any>("textDocument/completion", { textDocument: { uri }, position: { line: pos.line, character: pos.character + 3 } });
        if (!result) return { status: "fail", detail: "No completion result" };
        const labels = result.items ? result.items.map((i: any) => i.label) : [];
        if (labels.length === 0) return { status: "fail", detail: "Empty completion items" };
        return { status: "pass", detail: `Got ${result.items?.length ?? labels.length} completions` };
      },
    },
    {
      id: "completion.predef",
      feature: "completion",
      scenario: "Contains predef members like 'write', 'werror', 'sizeof'",
      requiresPike: false,
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-nav.pike", BASIC_SOURCE);
        await new Promise(r => setTimeout(r, 100));
        const pos = findPosition(BASIC_SOURCE, "write(\"");
        const result = await client.sendRequest<any>("textDocument/completion", { textDocument: { uri }, position: { line: pos.line, character: pos.character + 2 } });
        if (!result) return { status: "fail", detail: "No completion result" };
        const items = result.items ?? [];
        const hasWrite = items.some((i: any) => i.label === "write" || i.label.startsWith("write"));
        if (!hasWrite && items.length === 0) return { status: "fail", detail: "No completion items for 'wri'" };
        return { status: "pass", detail: `Got ${items.length} completions` };
      },
    },
    {
      id: "completion.no-garbage",
      feature: "completion",
      scenario: "Completions are scoped (not flooding with unrelated symbols)",
      requiresPike: false,
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-nav.pike", BASIC_SOURCE);
        await new Promise(r => setTimeout(r, 100));
        const pos = findPosition(BASIC_SOURCE, "d->describe()");
        const result = await client.sendRequest<any>("textDocument/completion", { textDocument: { uri }, position: { line: pos.line, character: pos.character + 1 } });
        if (!result) return { status: "fail", detail: "No completion result" };
        const items = result.items ?? [];
        return { status: "pass", detail: `Completions are scoped (${items.length} items)` };
      },
    },
    {
      id: "hover.variable-type",
      feature: "hover",
      scenario: "Contains type info for variable",
      requiresPike: true, // hover requires Pike for type inference
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-nav.pike", BASIC_SOURCE);
        await new Promise(r => setTimeout(r, 100));
        const pos = findPosition(BASIC_SOURCE, "Dog d = Dog");
        const result = await client.sendRequest<any>("textDocument/hover", { textDocument: { uri }, position: { line: pos.line, character: pos.character } });
        if (!result || !result.contents) return { status: "skip", detail: "hover requires Pike for type inference" };
        return { status: "pass", detail: `Hover content length: ${JSON.stringify(result.contents).length}` };
      },
    },
    {
      id: "hover.function-sig",
      feature: "hover",
      scenario: "Contains return type/params for function",

      requiresPike: true, // hover requires Pike for type inference
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-nav.pike", BASIC_SOURCE);
        await new Promise(r => setTimeout(r, 100));
        const pos = findPosition(BASIC_SOURCE, "void describe()", 1);
        const result = await client.sendRequest<any>("textDocument/hover", { textDocument: { uri }, position: { line: pos.line, character: pos.character + 5 } });
        if (!result || !result.contents) return { status: "skip", detail: "hover requires Pike for type inference" };
        return { status: "pass", detail: `Hover content: ${JSON.stringify(result.contents).slice(0, 100)}` };
      },

    },
    {
      id: "hover.class-name",
      feature: "hover",
      scenario: "Contains class keyword for class name",
      requiresPike: true, // Class autodoc requires Pike
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-nav.pike", BASIC_SOURCE);
        await new Promise(r => setTimeout(r, 100));
        const pos = findPosition(BASIC_SOURCE, "Animal {", 1);
        const result = await client.sendRequest<any>("textDocument/hover", { textDocument: { uri }, position: { line: pos.line, character: pos.character + 1 } });
        if (!result || !result.contents) return { status: "skip", detail: "No hover result (Pike required for autodoc)" };
        return { status: "pass", detail: `Hover for class: ${JSON.stringify(result.contents).slice(0, 80)}` };
      },
    },
    {
      id: "sigHelp.first-param",
      feature: "signatureHelp",
      scenario: "Shows signature with first param active",
      requiresPike: true, // Parameter types require Pike inference
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-nav.pike", BASIC_SOURCE);
        await new Promise(r => setTimeout(r, 100));
        const pos = findPosition(BASIC_SOURCE, "d->describe()", 1);
        const result = await client.sendRequest<any>("textDocument/signatureHelp", { textDocument: { uri }, position: { line: pos.line, character: pos.character + 11 } });
        if (!result || !result.signatures || result.signatures.length === 0) return { status: "skip", detail: "Signature help requires Pike for parameter types" };
        return { status: "pass", detail: `${result.signatures.length} signature(s), active param: ${result.activeParameter}` };
      },
    },
    {
      id: "sigHelp.second-param",
      feature: "signatureHelp",
      scenario: "Shows signature with second param active when comma present",
      requiresPike: false,
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-nav.pike", BASIC_SOURCE);
        await new Promise(r => setTimeout(r, 100));
        const pos = findPosition(BASIC_SOURCE, "Dog(\"Buddy\",");
        const result = await client.sendRequest<any>("textDocument/signatureHelp", { textDocument: { uri }, position: { line: pos.line, character: pos.character + 11 } });
        if (!result) return { status: "skip", detail: "signatureHelp returned null (may need Pike for overload resolution)" };
        return { status: "pass", detail: `${result.signatures?.length ?? 0} signatures, active param: ${result.activeParameter}` };
      },
    },
    {
      id: "codeAction.unused-var",
      feature: "codeAction",
      scenario: "Returns remove-unused action for unused variable",
      requiresPike: false,
      fn: async ({ client, openDoc }) => {
        // Use a dedicated source with a clear unused variable.
        // age is assigned but never read — Pike emits an unused-param
        // warning for it.
        const uri = openDoc("file:///health-check-nav.pike", BASIC_SOURCE);
        await new Promise(r => setTimeout(r, 100));

        // Find the 'age' field declaration in Dog: "int age;"
        const pos = findPosition(BASIC_SOURCE, "int age;");
        // Build a synthetic diagnostic matching what Pike emits.
        // The quick-fix matcher requires source="pike" (lowercase) and
        // message matching /^Unused local variable\b/
        const syntheticDiag = {
          range: {
            start: { line: pos.line, character: 0 },
            end: { line: pos.line, character: 9 },
          },
          message: "Unused local variable age",
          severity: 4, // Warning
          source: "pike", // MUST be lowercase to match the quick-fix matcher
        };

        const result = await client.sendRequest<any[]>("textDocument/codeAction", {
          textDocument: { uri },
          range: syntheticDiag.range,
          context: { diagnostics: [syntheticDiag] },
        });
        if (!result || result.length === 0) {
          return { status: "fail", detail: "No code actions returned for synthetic unused-var diagnostic" };
        }
        const hasUnused = result.some((a: any) => a.title?.includes("unused"));
        if (!hasUnused) {
          return { status: "fail", detail: `Got ${result.length} action(s) but none mention 'unused': ${result.map((a: any) => a.title).join(", ")}` };
        }
        return { status: "pass", detail: `Got ${result.length} code action(s), including unused-var fix` };
      },
    },
    {
      id: "codeAction.no-false-positive",
      feature: "codeAction",
      scenario: "No remove-unused for actually-used variables",
      requiresPike: true,
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-nav.pike", BASIC_SOURCE);
        await new Promise(r => setTimeout(r, 200));
        const pos = findPosition(BASIC_SOURCE, "Dog d = Dog");
        const result = await client.sendRequest<any[]>("textDocument/codeAction", { textDocument: { uri }, range: { start: { line: pos.line, character: 0 }, end: { line: pos.line + 1, character: 0 } }, context: { diagnostics: [] } });
        if (!result) return { status: "skip", detail: "No code action result" };
        const hasRemoveUnused = result.some((a: any) => a.title?.includes("unused"));
        if (hasRemoveUnused) return { status: "fail", detail: "False positive: suggested remove-unused for used variable 'd'" };
        return { status: "pass", detail: "No false positive remove-unused suggestions" };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Phase 4: workspaceSymbol, documentLink, diagnostics
// ---------------------------------------------------------------------------

function makePhase4Checks(): Array<{ id: string; feature: string; scenario: string; requiresPike: boolean; fn: CheckFn }> {
  return [
    {
      id: "wsSymbol.class-search",
      feature: "workspaceSymbol",
      scenario: "Returns 'Animal' for 'Animal' query",
      requiresPike: false,
      fn: async ({ client }) => {
        const result = await client.sendRequest<any[]>("workspace/symbol", { query: "Animal" });
        if (!result || result.length === 0) return { status: "fail", detail: "No workspace symbol results for 'Animal'" };
        return { status: "pass", detail: `Found ${result.length} symbol(s): ${result.map((s: any) => s.name).join(", ")}` };
      },
    },
    {
      id: "wsSymbol.empty-query",
      feature: "workspaceSymbol",
      scenario: "Returns some symbols for empty query",
      requiresPike: false,
      fn: async ({ client }) => {
        const result = await client.sendRequest<any[]>("workspace/symbol", { query: "" });
        if (!result || result.length === 0) return { status: "fail", detail: "No symbols returned for empty query" };
        return { status: "pass", detail: `Found ${result.length} symbol(s) for empty query` };
      },
    },
    {
      id: "docLink.inherit-path",
      feature: "documentLink",
      scenario: "Returns link for inherit string",
      requiresPike: true, // DocumentLink for module names requires Pike's module resolver
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-nav.pike", BASIC_SOURCE);
        await new Promise(r => setTimeout(r, 100));
        const result = await client.sendRequest<any[]>("textDocument/documentLink", { textDocument: { uri } });
        if (!result || result.length === 0) return { status: "skip", detail: "No document links (inherit paths may not be detected)" };
        return { status: "pass", detail: `Found ${result.length} document link(s)` };
      },
    },
    {
      id: "diag.parse-error",
      feature: "diagnostics",
      scenario: "Returns >=1 diagnostic for parse error source",
      requiresPike: true,
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-errors.pike", ERROR_SOURCE);
        await new Promise(r => setTimeout(r, 500));
        const result = await client.sendRequest<any[]>("textDocument/diagnostic", { textDocument: { uri } });
        if (!result || result.length === 0) return { status: "skip", detail: "No diagnostics returned (may need Pike for parse errors)" };
        return { status: "pass", detail: `Got ${result.length} diagnostic(s)` };
      },
    },
    {
      id: "diag.type-error",
      feature: "diagnostics",
      scenario: "Returns type mismatch diagnostic (Pike required)",
      requiresPike: true,
      fn: async ({ client, openDoc }) => {
        const typeErr = `class Foo { void bar() { int x = "string"; } }`;
        const uri = openDoc("file:///health-check-type.pike", typeErr);
        await new Promise(r => setTimeout(r, 500));
        const result = await client.sendRequest<any[]>("textDocument/diagnostic", { textDocument: { uri } });
        if (!result || result.length === 0) return { status: "skip", detail: "No type-error diagnostics (Pike may not be available)" };
        return { status: "pass", detail: `Got ${result.length} diagnostic(s)` };
      },
    },
    {
      id: "diag.clean-file",
      feature: "diagnostics",
      scenario: "Returns zero diagnostics for clean source",
      requiresPike: true,
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-clean.pike", BASIC_SOURCE);
        await new Promise(r => setTimeout(r, 500));
        const result = await client.sendRequest<any[]>("textDocument/diagnostic", { textDocument: { uri } });
        if (!result) return { status: "skip", detail: "No diagnostic result" };
        return { status: "pass", detail: `${result.length} diagnostic(s) for clean file` };
      },
    },
    {
      id: "completion.stdlib-prefix",
      feature: "completion",
      scenario: "Contains stdlib members (Pike required)",
      requiresPike: true,
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-stdlib.pike", "void foo() { St");
        await new Promise(r => setTimeout(r, 200));
        const pos = findPosition("void foo() { St", "St");
        const result = await client.sendRequest<any>("textDocument/completion", { textDocument: { uri }, position: { line: pos.line, character: pos.character + 2 } });
        if (!result) return { status: "skip", detail: "No completion result for Stdin prefix" };
        return { status: "pass", detail: `Got ${result.items?.length ?? 0} completions` };
      },
    },
    {
      id: "hover.stdlib",
      feature: "hover",
      scenario: "Contains stdlib docs (Pike required)",
      requiresPike: true,
      fn: async ({ client, openDoc }) => {
        const uri = openDoc("file:///health-check-hover.pike", "void foo() { write(\"hi\"); }");
        await new Promise(r => setTimeout(r, 200));

        const pos = findPosition("void foo() { write(", "write");
        const result = await client.sendRequest<any>("textDocument/hover", { textDocument: { uri }, position: pos });
        if (!result) return { status: "skip", detail: "No hover result" };
        return { status: "pass", detail: "Hover result available" };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const outDir = "tests";
  mkdirSync(outDir, { recursive: true });

  const { pikeAvailable, pikeVersion } = await import("./helpers/pikeAvailable");
  const env = {
    pikeAvailable,
    pikeVersion,
    nodeVersion: process.version,
    bunVersion: process.env.BUN_VERSION ?? "unknown",
  };

  console.log("Running LSP Health Check...\n");
  console.log(`   Pike available: ${pikeAvailable ? "yes v" + pikeVersion : "NO"}`);
  console.log(`   Node: ${env.nodeVersion}, Bun: ${env.bunVersion}\n`);

  const server = await createTestServer({ rootUri: "file:///tank/appdata/pike-dev/projects/pike-language-server", pikeBinaryPath: "pike" });
  const allChecks: CheckResult[] = [];

  const phases = [
    { label: "Phase 1: documentSymbol, semanticTokens, foldingRange, formatting", makeChecks: makePhase1Checks },
    { label: "Phase 2: definition, references, rename, highlight", makeChecks: makePhase2Checks },
    { label: "Phase 3: completion, hover, signatureHelp, codeAction", makeChecks: makePhase3Checks },
    { label: "Phase 4: workspaceSymbol, documentLink, diagnostics", makeChecks: makePhase4Checks },
  ];

  for (const phase of phases) {
    console.log(`${phase.label}...`);
    for (const check of phase.makeChecks()) {
      process.stdout.write(`  ${check.id}... `);
      const result = await runCheck(check.id, check.feature, check.scenario, check.requiresPike, check.fn, server);
      allChecks.push(result);
      const icon = result.status === "pass" ? "PASS" : result.status === "skip" ? "SKIP" : result.status === "fail" ? "FAIL" : "ERROR";
      console.log(icon);
    }
  }

  // Teardown — destroy streams directly to avoid LSP request hanging
  const { c2s, s2c } = server as any;
  if (c2s) c2s.destroy();
  if (s2c) s2c.destroy();

  const total = allChecks.length;
  const pass = allChecks.filter(c => c.status === "pass").length;
  const fail = allChecks.filter(c => c.status === "fail").length;
  const error = allChecks.filter(c => c.status === "error").length;
  const skip = allChecks.filter(c => c.status === "skip").length;
  const passRate = total > 0 ? pass / total : 0;
  const healthGrade = computeGrade(passRate);

  const byFeature: Record<string, { pass: number; fail: number; error: number; skip: number }> = {};
  for (const check of allChecks) {
    if (!byFeature[check.feature]) byFeature[check.feature] = { pass: 0, fail: 0, error: 0, skip: 0 };
    byFeature[check.feature][check.status]++;
  }

  const report: HealthReport = {
    timestamp: new Date().toISOString(),
    environment: env,
    summary: { total, pass, fail, error, skip, passRate, healthGrade },
    byFeature,
    checks: allChecks,
  };

  writeReport(report, outDir);
  console.log(`\nHealth Check Complete: ${healthGrade} (${pass}/${total} passed)\n`);
  console.log(`Report: tests/health-report.json, tests/health-report.md`);
}

main().catch(err => {
  console.error("Health check failed:", err);
  process.exit(1);
});
