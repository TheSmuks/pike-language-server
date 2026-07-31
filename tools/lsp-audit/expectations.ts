/**
 * Tier-2 correctness expectations.
 *
 * Tiers 0, 1 and 3 need no ground truth: a crash, an empty result where one is
 * mandatory, and a slow response are all self-evident. Tier 2 — "answered, but
 * wrongly" — needs a known-correct answer, so it is scoped to a curated subset
 * of the corpus where the right answer is unambiguous.
 *
 * Every entry below was derived by reading the Pike source and reasoning out
 * the answer from language semantics, then cross-checked against the real
 * `pike` binary only where the question was "does this even compile" (never
 * "what does the language server say") — see task-6-report.md for the full
 * per-entry reasoning and which files that applied to.
 */

export type ExpectedResult =
  | { kind: "definitionAt"; file: string; line: number }
  | { kind: "hoverContains"; text: string }
  | { kind: "referenceCount"; count: number }
  | { kind: "renameAllowed"; allowed: boolean }
  | { kind: "completionIncludes"; label: string };

export interface Expectation {
  /** Path relative to corpus/files. */
  file: string;
  /** 0-based LSP coordinates. */
  line: number;
  character: number;
  method: string;
  expect: ExpectedResult;
}

export const EXPECTATIONS: Expectation[] = [
  // --- cross-lib-consumer.pike -----------------------------------------
  // `bf->format("hello")` — BracketFormatter declares its own format(), which
  // shadows anything it might inherit, so this resolves locally regardless of
  // how the file-level `inherit "cross-lib-base.pike";` above resolves.
  {
    file: "cross-lib-consumer.pike",
    line: 32,
    character: 22,
    method: "textDocument/definition",
    expect: { kind: "definitionAt", file: "cross-lib-consumer.pike", line: 25 },
  },
  // `bf` is declared once (line 31) and used once (line 32): 2 occurrences,
  // and references is requested with includeDeclaration: true.
  {
    file: "cross-lib-consumer.pike",
    line: 31,
    character: 19,
    method: "textDocument/references",
    expect: { kind: "referenceCount", count: 2 },
  },

  // --- cross-lib-base.pike ----------------------------------------------
  // `prefix` used inside format() resolves to the field declared two lines
  // into the class body.
  {
    file: "cross-lib-base.pike",
    line: 17,
    character: 11,
    method: "textDocument/definition",
    expect: { kind: "definitionAt", file: "cross-lib-base.pike", line: 8 },
  },
  // get_prefix() is declared `string get_prefix()`. Assert the full
  // declaration, not the bare type keyword "string" — every hover in this
  // corpus mentions some type, so that alone would pass even if hover
  // resolved to a completely different symbol.
  {
    file: "cross-lib-base.pike",
    line: 20,
    character: 9,
    method: "textDocument/hover",
    expect: { kind: "hoverContains", text: "string get_prefix" },
  },

  // --- cross-inherit-simple-a.pike ---------------------------------------
  // SPECIES used in describe() resolves to the file-level constant.
  {
    file: "cross-inherit-simple-a.pike",
    line: 28,
    character: 9,
    method: "textDocument/definition",
    expect: { kind: "definitionAt", file: "cross-inherit-simple-a.pike", line: 7 },
  },
  // `name` (the Animal field, not the `_name` parameter, which the word
  // boundary excludes) appears at: declaration (11), assignment in create()
  // (15), speak() (20), get_name() (24) — 4 occurrences total.
  {
    file: "cross-inherit-simple-a.pike",
    line: 10,
    character: 19,
    method: "textDocument/references",
    expect: { kind: "referenceCount", count: 4 },
  },

  // --- class-single-inherit.pike ------------------------------------------
  // Dog inherits only Animal, so unqualified `::create(...)` in Dog.create()
  // can only mean Animal.create().
  {
    file: "class-single-inherit.pike",
    line: 29,
    character: 6,
    method: "textDocument/definition",
    expect: { kind: "definitionAt", file: "class-single-inherit.pike", line: 10 },
  },
  // `breed` (the second occurrence on that line — the first is the literal
  // text "breed:" inside the string) is a `protected string breed;` field.
  // "string breed" (type immediately followed by name, as written in source)
  // is a literal substring of that declaration regardless of whether the
  // rendered signature keeps the `protected` modifier.
  {
    file: "class-single-inherit.pike",
    line: 36,
    character: 40,
    method: "textDocument/hover",
    expect: { kind: "hoverContains", text: "string breed" },
  },

  // --- class-create.pike ---------------------------------------------------
  // `id` inside Base.create() is `protected int id;`.
  {
    file: "class-create.pike",
    line: 10,
    character: 4,
    method: "textDocument/hover",
    expect: { kind: "hoverContains", text: "int" },
  },
  // `label` is an ordinary user-declared field; renaming it is unremarkable.
  {
    file: "class-create.pike",
    line: 20,
    character: 19,
    method: "textDocument/prepareRename",
    expect: { kind: "renameAllowed", allowed: true },
  },

  // --- class-this-object.pike -----------------------------------------------
  // `buf` is `string buf = "";` — "string buf" (type immediately followed by
  // name) is a literal substring of that declaration regardless of whether
  // the rendered signature keeps the initializer.
  {
    file: "class-this-object.pike",
    line: 7,
    character: 4,
    method: "textDocument/hover",
    expect: { kind: "hoverContains", text: "string buf" },
  },
  // `this` is a reserved keyword referring to the current object, not a
  // declared symbol — there is nothing to rename.
  {
    file: "class-this-object.pike",
    line: 8,
    character: 11,
    method: "textDocument/prepareRename",
    expect: { kind: "renameAllowed", allowed: false },
  },

  // --- cross-stdlib.pike -----------------------------------------------------
  // `f` is declared `Stdio.File f = Stdio.File();`.
  {
    file: "cross-stdlib.pike",
    line: 14,
    character: 6,
    method: "textDocument/hover",
    expect: { kind: "hoverContains", text: "File" },
  },
  // Completion right after "Stdio." must offer the well-known stdlib class
  // Stdio.File (the file itself constructs one two tokens later).
  {
    file: "cross-stdlib.pike",
    line: 9,
    character: 8,
    method: "textDocument/completion",
    expect: { kind: "completionIncludes", label: "File" },
  },

  // --- cross-import-b.pike ----------------------------------------------------
  // `import cross_import_a;` is a plain module import (not the dot-path
  // syntax that fails to resolve elsewhere in the corpus — see
  // cross-lib-consumer.pike below and the report). LIBRARY_VERSION is
  // declared as a constant at the top of cross_import_a.pmod.
  {
    file: "cross-import-b.pike",
    line: 12,
    character: 25,
    method: "textDocument/definition",
    expect: { kind: "definitionAt", file: "cross_import_a.pmod", line: 9 },
  },
  // `g` is a Greeter; Greeter declares a `greet` method directly.
  {
    file: "cross-import-b.pike",
    line: 17,
    character: 26,
    method: "textDocument/completion",
    expect: { kind: "completionIncludes", label: "greet" },
  },

  // --- class-multi-inherit.pike ------------------------------------------------
  // `A::value()` is an explicitly qualified call — unambiguous regardless of
  // the name collision the file otherwise exercises.
  {
    file: "class-multi-inherit.pike",
    line: 17,
    character: 24,
    method: "textDocument/definition",
    expect: { kind: "definitionAt", file: "class-multi-inherit.pike", line: 4 },
  },
  // `label` (B's method, not A's `name`/`value`) is declared once and called
  // once via `B::label()`: 2 occurrences.
  {
    file: "class-multi-inherit.pike",
    line: 10,
    character: 9,
    method: "textDocument/references",
    expect: { kind: "referenceCount", count: 2 },
  },

  // --- cross-inherit-chain-a.pike -----------------------------------------------
  // `identify` is an ordinary method; renaming it is unremarkable.
  {
    file: "cross-inherit-chain-a.pike",
    line: 14,
    character: 9,
    method: "textDocument/prepareRename",
    expect: { kind: "renameAllowed", allowed: true },
  },
  // `label` appears at: declaration (9), assignment in create() (12), use in
  // identify() (16) — 3 occurrences.
  {
    file: "cross-inherit-chain-a.pike",
    line: 8,
    character: 19,
    method: "textDocument/references",
    expect: { kind: "referenceCount", count: 3 },
  },
];

/**
 * Every position an expectation targets, keyed by corpus-relative filename.
 *
 * Fed to the sweep as `extraPositions`. Without it the sweep only visits
 * positions named by TOP-LEVEL documentSymbol entries, which reaches 1 of 20
 * expectations — fields, locals and class members are never emitted as
 * top-level symbols, so tier 2 would check almost nothing.
 */
export function expectationPositions(): Map<string, Array<{ line: number; character: number }>> {
  const byFile = new Map<string, Array<{ line: number; character: number }>>();
  for (const e of EXPECTATIONS) {
    const list = byFile.get(e.file) ?? [];
    list.push({ line: e.line, character: e.character });
    byFile.set(e.file, list);
  }
  return byFile;
}

/**
 * Adapt the expectation set to the sweep's CorrectnessChecker interface.
 *
 * Returns null when nothing covers this (file, method, position) — the common
 * case — so the sweep falls back to the capability's own validator.
 */
export function expectationChecker() {
  const index = new Map<string, Expectation>();
  for (const e of EXPECTATIONS) {
    index.set(`${e.file}|${e.method}|${e.line}:${e.character}`, e);
  }
  return (
    file: string,
    method: string,
    position: { line: number; character: number } | null,
    result: unknown,
  ): boolean | null => {
    if (!position) return null;
    const found = index.get(`${file}|${method}|${position.line}:${position.character}`);
    return found ? checkExpectation(found, result) : null;
  };
}

export function checkExpectation(expectation: Expectation, result: unknown): boolean {
  const want = expectation.expect;

  // renameAllowed is checked BEFORE the null guard, because null is precisely
  // the correct prepareRename response for a non-renameable position. Guarding
  // first would make `allowed: false` unsatisfiable — it would report "wrong"
  // exactly when the server behaves correctly.
  if (want.kind === "renameAllowed") {
    return (result !== null && result !== undefined) === want.allowed;
  }
  if (result === null || result === undefined) return false;

  switch (want.kind) {
    case "definitionAt": {
      const locations = Array.isArray(result) ? result : [result];
      return locations.some((loc: { uri?: string; range?: { start?: { line: number } } }) =>
        loc.uri?.endsWith(want.file) && loc.range?.start?.line === want.line,
      );
    }
    case "hoverContains": {
      const contents = (result as { contents?: { value?: string } }).contents;
      return typeof contents?.value === "string" && contents.value.includes(want.text);
    }
    case "referenceCount":
      return Array.isArray(result) && result.length === want.count;
    // "renameAllowed" is handled by the early return above, before the null
    // guard — control-flow narrowing has already removed it from `want`'s
    // type here, so a case for it would not type-check as reachable.
    case "completionIncludes": {
      const items = Array.isArray(result) ? result : (result as { items?: unknown[] }).items ?? [];
      return items.some((item: { label?: string }) => item.label === want.label);
    }
  }
}
