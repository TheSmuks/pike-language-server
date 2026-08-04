/**
 * Regression: an efun whose type carries `__attribute__` must still render a
 * balanced signature.
 *
 * Hover stripped the annotation with a regex that matched only the opening
 * `__attribute__("...",` and left its closing paren behind. Every affected
 * efun then rendered garbage — `sprintf` hovered as the single line
 * `sprintf(object|string), mixed) ... : string)) → mixed`, and `write`/`werror`
 * grew a third overload reading `write(string), mixed) ... : int) → mixed`.
 *
 * signatureHelp already had a correct implementation. Two copies of one rule is
 * how they drifted, so both now call the same shared helper.
 */

import { describe, test, expect } from "bun:test";
import { renderPredefSignature } from "../../server/src/features/hoverContent";
import { stripAttributes } from "../../server/src/util/stripScope";

describe("predef signatures with __attribute__", () => {
  test("the annotation is replaced by the type it wraps", () => {
    expect(stripAttributes('__attribute__("sprintf_format", string)'))
      .toBe("string");
    expect(stripAttributes('function(__attribute__("sprintf_format", string), mixed ... : int)'))
      .toBe("function(string, mixed ... : int)");
  });

  test("text carrying no annotation is untouched", () => {
    expect(stripAttributes("function(string : int)")).toBe("function(string : int)");
  });

  test("every rendered overload has balanced parentheses", () => {
    // The real shape of sprintf's type in the predef data.
    const raw =
      'function(__attribute__("sprintf_format", object|string), ' +
      '__attribute__("sprintf_args", mixed) ... : string)';
    for (const line of renderPredefSignature("sprintf", raw)) {
      const open = (line.match(/\(/g) ?? []).length;
      const close = (line.match(/\)/g) ?? []).length;
      expect(open, `unbalanced: ${line}`).toBe(close);
    }
  });

  test("sprintf renders its real signature", () => {
    const raw =
      'function(__attribute__("sprintf_format", object|string), ' +
      '__attribute__("sprintf_args", mixed) ... : string)';
    const rendered = renderPredefSignature("sprintf", raw);
    expect(rendered).toEqual(["sprintf(object|string, mixed ...) → string"]);
  });

  test("no rendered overload leaks the annotation name", () => {
    const raw =
      'function(__attribute__("sprintf_format", string), ' +
      '__attribute__("sprintf_args", mixed) ... : int)';
    for (const line of renderPredefSignature("write", raw)) {
      expect(line).not.toContain("__attribute__");
      expect(line, `a stray type separator leaked into: ${line}`).not.toContain(" : ");
    }
  });
});
