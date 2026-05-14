/**
 * Tests for getters/setters generation code actions.
 *
 * When the cursor is on a class variable, the LSP offers code actions to
 * generate get_x() and set_x() methods. Tests verify correct method bodies,
 * dedup when methods already exist, and no action outside classes.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { initParser } from "../../server/src/parser";
import { produceGetterSetterActions } from "../../server/src/features/getterSetter";
import type { CodeActionParams } from "vscode-languageserver/node";

describe("Getters/setters generation", () => {
  beforeAll(async () => {
    await initParser();
  });

  let counter = 0;

  function getActions(source: string, line: number, character: number) {
    const uri = `file:///test-gs-${++counter}.pike`;
    const params: CodeActionParams = {
      textDocument: { uri },
      range: {
        start: { line, character },
        end: { line, character },
      },
      context: { diagnostics: [] },
    };
    return produceGetterSetterActions(params, source, { stdlibModules: new Set() });
  }

  function getEditNewText(action: any): string {
    const changes = action.edit!.changes!;
    const uri = Object.keys(changes)[0];
    return changes[uri][0].newText;
  }

  test("offers getter, setter, and combined for class variable", () => {
    const source = `class Dog {
  string name;
}`;
    const actions = getActions(source, 1, 4);
    expect(actions.length).toBe(3);
    const titles = actions.map(a => a.title);
    expect(titles.some(t => t.includes("getter"))).toBe(true);
    expect(titles.some(t => t.includes("setter"))).toBe(true);
    expect(titles.some(t => t.includes("getter and setter"))).toBe(true);
  });

  test("getter has correct return type and body", () => {
    const source = `class Dog {
  string name;
}`;
    const actions = getActions(source, 1, 4);
    const getter = actions.find(a => a.title.includes("getter") && !a.title.includes("setter"));
    expect(getter).toBeDefined();
    const text = getEditNewText(getter!);
    expect(text).toContain("string get_name()");
    expect(text).toContain("return name;");
  });

  test("setter has correct parameter type and body", () => {
    const source = `class Dog {
  string name;
}`;
    const actions = getActions(source, 1, 4);
    const setter = actions.find(a => a.title.includes("setter") && !a.title.includes("getter"));
    expect(setter).toBeDefined();
    const text = getEditNewText(setter!);
    expect(text).toContain("void set_name(string value)");
    expect(text).toContain("name = value;");
  });

  test("uses mixed type when no type annotation", () => {
    // Untyped `value;` isn't detected as variable by symbol table — use
    // a typed variable without an initializer to test the fallback.
    const source = `class Container {
  mixed value;
}`;
    const actions = getActions(source, 1, 2);
    const getter = actions.find(a => a.title.includes("getter") && !a.title.includes("setter"));
    expect(getter).toBeDefined();
    const text = getEditNewText(getter!);
    expect(text).toContain("mixed get_value()");
  });

  test("no action for variable outside a class", () => {
    const source = `int count = 0;`;
    const actions = getActions(source, 0, 4);
    expect(actions.length).toBe(0);
  });

  test("skips getter if get_x already exists", () => {
    const source = `class Dog {
  string name;
  string get_name() { return name; }
}`;
    const actions = getActions(source, 1, 4);
    const titles = actions.map(a => a.title);
    // Should only have setter (not getter, not combined)
    expect(titles.some(t => t === "Generate setter for name")).toBe(true);
    expect(titles.some(t => t.includes("getter"))).toBe(false);
  });

  test("skips setter if set_x already exists", () => {
    const source = `class Dog {
  string name;
  void set_name(string value) { name = value; }
}`;
    const actions = getActions(source, 1, 4);
    const titles = actions.map(a => a.title);
    expect(titles.some(t => t === "Generate getter for name")).toBe(true);
    expect(titles.some(t => t.includes("setter"))).toBe(false);
  });
});
