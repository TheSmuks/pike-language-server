/**
 * Tests for autodoc template generation via //!! trigger.
 *
 * Verifies that typing `//!!` above a function, method, class, or variable
 * produces a code action that replaces the trigger with a //! autodoc skeleton
 * populated with parameter names and return type.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { initParser } from "../../server/src/parser";
import { produceAutodocTemplateActions } from "../../server/src/features/autodocTemplate";
import type { CodeActionParams } from "vscode-languageserver/node";

describe("Autodoc template — //!! trigger", () => {
  beforeAll(async () => {
    await initParser();
  });

  let counter = 0;

  function getActions(source: string, triggerLine: number) {
    const uri = `file:///test-autodoc-${++counter}.pike`;
    const params: CodeActionParams = {
      textDocument: { uri },
      range: {
        start: { line: triggerLine, character: 0 },
        end: { line: triggerLine, character: 999 },
      },
      context: { diagnostics: [] },
    };
    return produceAutodocTemplateActions(params, source);
  }

  test("generates autodoc skeleton for function with parameters", () => {
    const source = `//!!
int add(int x, int y) {
  return x + y;
}`;
    const actions = getActions(source, 0);
    expect(actions.length).toBe(1);
    expect(actions[0].title).toContain("add");

    const edit = actions[0].edit!.changes!["file:///test-autodoc-1.pike" as any][0];
    const newText = edit.newText;
    expect(newText).toContain("//! add — description.");
    expect(newText).toContain("@param x");
    expect(newText).toContain("@param y");
    expect(newText).toContain("@returns");
  });

  test("generates autodoc skeleton for void function", () => {
    const source = `//!!
void greet(string name) {
}`;
    const actions = getActions(source, 0);
    expect(actions.length).toBe(1);

    const edit = actions[0].edit!.changes![Object.keys(actions[0].edit!.changes!)[0]][0];
    const newText = edit.newText;
    expect(newText).toContain("//! greet — description.");
    expect(newText).toContain("@param name");
    // No @returns for void functions
    expect(newText).not.toContain("@returns");
  });

  test("generates autodoc skeleton for class", () => {
    const source = `//!!
class Dog {
}`;
    const actions = getActions(source, 0);
    expect(actions.length).toBe(1);

    const edit = actions[0].edit!.changes![Object.keys(actions[0].edit!.changes!)[0]][0];
    const newText = edit.newText;
    expect(newText).toContain("//! Dog — description.");
    expect(newText).not.toContain("@param");
  });

  test("generates autodoc skeleton for variable", () => {
    const source = `//!!
int count = 0;`;
    const actions = getActions(source, 0);
    expect(actions.length).toBe(1);

    const edit = actions[0].edit!.changes![Object.keys(actions[0].edit!.changes!)[0]][0];
    const newText = edit.newText;
    expect(newText).toContain("//! count — description.");
  });

  test("no action when //!! is not on its own line", () => {
    const source = `//!! not a trigger
int add(int x, int y) { return x + y; }`;
    const actions = getActions(source, 0);
    // "!! not a trigger" is not "//!!" when trimmed — no action
    expect(actions.length).toBe(0);
  });

  test("no action when no declaration follows", () => {
    const source = `//!!
// just a comment`;
    const actions = getActions(source, 0);
    expect(actions.length).toBe(0);
  });

  test("preserves indentation from trigger line", () => {
    const source = `class Foo {
  //!!
  void bar(int x) {}
}`;
    const actions = getActions(source, 1);
    expect(actions.length).toBe(1);

    const edit = actions[0].edit!.changes![Object.keys(actions[0].edit!.changes!)[0]][0];
    const newText = edit.newText;
    expect(newText).toContain("  //! bar — description.");
    expect(newText).toContain("  //! @param x");
  });
});
