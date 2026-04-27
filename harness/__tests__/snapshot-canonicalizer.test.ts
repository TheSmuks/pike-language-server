/**
 * Tests for the snapshot canonicalizer and diff logic.
 *
 * These verify that:
 * 1. The canonicalizer handles arbitrary nesting and key ordering (Item 1 + Item 4)
 * 2. The diff logic is generic — new top-level fields are compared automatically
 * 3. pike_version is excluded from diff
 * 4. Deeply nested structures with shuffled keys produce identical output
 */

import { describe, test, expect } from "bun:test";
import {
  canonicalStringify,
  deepSortKeys,
  diffSnapshot,
} from "../src/snapshot";

// ---------------------------------------------------------------------------
// 1. Canonicalizer handles arbitrary nesting
// ---------------------------------------------------------------------------

describe("canonicalStringify", () => {
  test("sorts top-level keys alphabetically", () => {
    const a = { z: 1, a: 2, m: 3 };
    const b = { a: 2, m: 3, z: 1 };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  test("sorts nested object keys recursively", () => {
    const a = {
      outer: { z_inner: "last", a_inner: "first" },
      middle: [1, 2, 3],
    };
    const b = {
      middle: [1, 2, 3],
      outer: { a_inner: "first", z_inner: "last" },
    };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  test("handles arrays of objects with mixed key orders", () => {
    const a = {
      items: [
        { z: 1, a: 2 },
        { m: 3, b: 4 },
      ],
    };
    const b = {
      items: [
        { a: 2, z: 1 },
        { b: 4, m: 3 },
      ],
    };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  test("handles arrays containing both objects and primitives", () => {
    const a = {
      mixed: [
        "string",
        42,
        { nested: { deep: { z: true, a: false } } },
        null,
        true,
      ],
    };
    const b = {
      mixed: [
        "string",
        42,
        { nested: { deep: { a: false, z: true } } },
        null,
        true,
      ],
    };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  test("handles deeply nested structures (5+ levels)", () => {
    // Build an object 6 levels deep with shuffled keys at every level
    const makeDeep = (level: number): Record<string, unknown> => {
      if (level === 0) return { value: "leaf" };
      return {
        [`z${level}`]: makeDeep(level - 1),
        [`a${level}`]: makeDeep(level - 1),
        [`m${level}`]: level,
      };
    };

    // Same structure, different key order at construction
    const makeDeepReversed = (level: number): Record<string, unknown> => {
      if (level === 0) return { value: "leaf" };
      return {
        [`a${level}`]: makeDeepReversed(level - 1),
        [`m${level}`]: level,
        [`z${level}`]: makeDeepReversed(level - 1),
      };
    };

    const a = makeDeep(6);
    const b = makeDeepReversed(6);
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  test("handles null, undefined, and empty values", () => {
    const a = { n: null, e: "", z: 0, arr: [], obj: {} };
    const b = { obj: {}, z: 0, arr: [], e: "", n: null };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  test("produces different output for actually different values", () => {
    const a = { x: 1, y: { nested: "same" } };
    const b = { x: 1, y: { nested: "different" } };
    expect(canonicalStringify(a)).not.toBe(canonicalStringify(b));
  });
});

// ---------------------------------------------------------------------------
// 2. deepSortKeys returns sorted structure (not just string)
// ---------------------------------------------------------------------------

describe("deepSortKeys", () => {
  test("returns an object with sorted keys", () => {
    const result = deepSortKeys({ z: 1, a: 2, m: 3 }) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(["a", "m", "z"]);
  });

  test("recursively sorts nested objects", () => {
    const result = deepSortKeys({
      outer: { z: 1, a: 2 },
    }) as Record<string, unknown>;
    const outer = result.outer as Record<string, unknown>;
    expect(Object.keys(outer)).toEqual(["a", "z"]);
  });

  test("passes primitives through unchanged", () => {
    expect(deepSortKeys(42)).toBe(42);
    expect(deepSortKeys("hello")).toBe("hello");
    expect(deepSortKeys(true)).toBe(true);
    expect(deepSortKeys(null)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// 3. Generic diff handles new top-level fields (extensibility)
// ---------------------------------------------------------------------------

describe("diffSnapshot extensibility", () => {
  test("detects no diff when new fields are identical", () => {
    const actual = {
      file: "test.pike",
      pike_version: "8.0.1116",
      compilation: { exit_code: 0, strict_types: true },
      diagnostics: [],
      autodoc: null,
      error: null,
      // Phase 3 fields:
      symbols: [
        { name: "foo", kind: "function", line: 1, children: [
          { name: "bar", kind: "variable", line: 2, children: [] }
        ]},
      ],
    } as Record<string, unknown>;

    const expected = {
      pike_version: "8.0.1117", // Different — should be ignored
      file: "test.pike",
      compilation: { strict_types: true, exit_code: 0 },
      diagnostics: [],
      autodoc: null,
      error: null,
      // Phase 3 fields in different key order:
      symbols: [
        { children: [
          { children: [], line: 2, kind: "variable", name: "bar" }
        ], line: 1, kind: "function", name: "foo" },
      ],
    } as Record<string, unknown>;

    const diffs = diffSnapshot(
      actual as any,
      expected as any,
    );
    expect(diffs).toBeNull();
  });

  test("detects diff when new fields differ", () => {
    const actual = {
      file: "test.pike",
      pike_version: "8.0.1116",
      compilation: { exit_code: 0, strict_types: true },
      diagnostics: [],
      autodoc: null,
      error: null,
      symbols: [{ name: "foo", kind: "function" }],
    } as Record<string, unknown>;

    const expected = {
      file: "test.pike",
      pike_version: "8.0.1116",
      compilation: { exit_code: 0, strict_types: true },
      diagnostics: [],
      autodoc: null,
      error: null,
      symbols: [{ name: "bar", kind: "variable" }],
    } as Record<string, unknown>;

    const diffs = diffSnapshot(
      actual as any,
      expected as any,
    );
    expect(diffs).not.toBeNull();
    expect(diffs!.some((d) => d.field === "symbols")).toBe(true);
  });

  test("detects diff when a field is missing from one side", () => {
    const actual = {
      file: "test.pike",
      pike_version: "8.0.1116",
      compilation: { exit_code: 0, strict_types: true },
      diagnostics: [],
      autodoc: null,
      error: null,
      symbols: [],
    } as Record<string, unknown>;

    const expected = {
      file: "test.pike",
      pike_version: "8.0.1116",
      compilation: { exit_code: 0, strict_types: true },
      diagnostics: [],
      autodoc: null,
      error: null,
      // symbols field missing
    } as Record<string, unknown>;

    const diffs = diffSnapshot(
      actual as any,
      expected as any,
    );
    expect(diffs).not.toBeNull();
    // undefined (missing) serializes to undefined, which canonicalStringify treats as missing
    const symDiff = diffs!.find((d) => d.field === "symbols");
    expect(symDiff).toBeDefined();
  });

  test("ignores pike_version differences", () => {
    const actual = {
      file: "test.pike",
      pike_version: "8.0.1116",
      compilation: { exit_code: 0, strict_types: true },
      diagnostics: [],
      autodoc: null,
      error: null,
    } as Record<string, unknown>;

    const expected = {
      file: "test.pike",
      pike_version: "8.0.9999", // Completely different
      compilation: { exit_code: 0, strict_types: true },
      diagnostics: [],
      autodoc: null,
      error: null,
    } as Record<string, unknown>;

    const diffs = diffSnapshot(
      actual as any,
      expected as any,
    );
    expect(diffs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Complex nested shapes — the "shapes more complex than current snapshots"
// ---------------------------------------------------------------------------

describe("canonicalizer handles complex shapes", () => {
  test("nested arrays of objects with varying schemas", () => {
    const shape = {
      symbols: [
        {
          name: "MyClass",
          kind: "class",
          line: 1,
          children: [
            {
              name: "create",
              kind: "method",
              line: 2,
              signature: {
                params: [
                  { name: "x", type: "int" },
                  { name: "y", type: "string" },
                ],
                return_type: "void",
              },
              children: [],
            },
            {
              name: "value",
              kind: "variable",
              line: 5,
              type_info: {
                declared: "int",
                inferred: "int(0..)",
                generic_args: [],
              },
              children: [],
            },
          ],
        },
        {
          name: "main",
          kind: "function",
          line: 10,
          children: [],
        },
      ],
      types: {
        "MyClass": {
          inherits: ["Parent", "Mixin"],
          members: {
            public: ["create", "value"],
            protected: ["internal"],
          },
        },
      },
    };

    // Shuffle keys at every level
    const shuffled = JSON.parse(JSON.stringify(shape));
    const shuffleKeys = (obj: any): void => {
      if (obj === null || typeof obj !== "object") return;
      if (Array.isArray(obj)) {
        obj.forEach(shuffleKeys);
        return;
      }
      const keys = Object.keys(obj);
      // Fisher-Yates shuffle
      for (let i = keys.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [keys[i], keys[j]] = [keys[j], keys[i]];
      }
      // Rebuild in shuffled order
      const rebuilt: Record<string, unknown> = {};
      for (const k of keys) {
        rebuilt[k] = obj[k];
      }
      // Clear and re-assign
      Object.keys(obj).forEach((k) => delete obj[k]);
      Object.assign(obj, rebuilt);
      // Recurse into values
      Object.values(obj).forEach(shuffleKeys);
    };
    shuffleKeys(shuffled);

    expect(canonicalStringify(shape)).toBe(canonicalStringify(shuffled));
  });

  test("handles symbol table shape with generics and cross-references", () => {
    const phase3Shape = {
      file: "test.pike",
      pike_version: "8.0.1116",
      compilation: { exit_code: 0, strict_types: true },
      diagnostics: [],
      autodoc: null,
      error: null,
      symbols: [
        {
          name: "Container",
          kind: "class",
          line: 1,
          type_params: ["T"],
          members: [
            { name: "value", kind: "variable", type: "T", line: 3 },
            {
              name: "create",
              kind: "method",
              line: 2,
              overloads: [
                { params: [{ type: "T", name: "v" }], return_type: "void" },
              ],
            },
          ],
        },
      ],
      type_index: {
        "Container": { file: "test.pike", line: 1, generic: true },
      },
    };

    // Shuffle and verify
    const shuffled = JSON.parse(JSON.stringify(phase3Shape));
    const shuffleKeys = (obj: any): void => {
      if (obj === null || typeof obj !== "object") return;
      if (Array.isArray(obj)) {
        obj.forEach(shuffleKeys);
        return;
      }
      const keys = Object.keys(obj);
      for (let i = keys.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [keys[i], keys[j]] = [keys[j], keys[i]];
      }
      const rebuilt: Record<string, unknown> = {};
      for (const k of keys) rebuilt[k] = obj[k];
      Object.keys(obj).forEach((k) => delete obj[k]);
      Object.assign(obj, rebuilt);
      Object.values(obj).forEach(shuffleKeys);
    };
    shuffleKeys(shuffled);

    expect(canonicalStringify(phase3Shape)).toBe(canonicalStringify(shuffled));

    // Also verify diff is null for same-content different-ordering
    const diffs = diffSnapshot(phase3Shape as any, shuffled as any);
    expect(diffs).toBeNull();
  });
});
