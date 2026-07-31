/**
 * Element-type extraction for subscripted member access.
 *
 * `items[k]->m` resolves the member on what the container HOLDS, so this
 * function decides which class is searched. A wrong answer here resolves a
 * member to the wrong declaration — worse than resolving nothing — so the
 * nested-generic rows below matter as much as the simple ones: they must
 * produce a type string that matches no class, not a plausible wrong one.
 */

import { describe, test, expect } from "bun:test";
import { elementTypeOf } from "../../server/src/features/typeResolver";

describe("elementTypeOf", () => {
  test("extracts the value type of a mapping and the element of an array", () => {
    expect(elementTypeOf("mapping(string:Item)")).toBe("Item");
    expect(elementTypeOf("array(Item)")).toBe("Item");
    expect(elementTypeOf("array( Item )")).toBe("Item");
  });

  test("keeps a module-qualified element type intact", () => {
    // Resolving Stdio.File is a separate (unimplemented) concern; this must
    // not mangle the name on the way there.
    expect(elementTypeOf("mapping(string:Stdio.File)")).toBe("Stdio.File");
  });

  test("nested generics fail safely rather than naming a wrong class", () => {
    // These are not resolved today. What matters is that each returns a string
    // no class can match, so the lookup MISSES instead of hitting the wrong
    // declaration.
    expect(elementTypeOf("mapping(string:array(Item))")).toBe("array(Item)");
    expect(elementTypeOf("array(mapping(string:Item))")).toBe("mapping(string:Item)");
    // A mapping keyed by a mapping defeats the non-greedy key match. The result
    // is garbage — but garbage that matches no class, which is the safe failure.
    expect(elementTypeOf("mapping(mapping(string:int):Item)")).not.toBe("Item");
  });

  test("returns null for containers with no usable element type", () => {
    expect(elementTypeOf("mapping")).toBeNull();
    expect(elementTypeOf("array")).toBeNull();
    // multiset subscripting yields an int, not an element.
    expect(elementTypeOf("multiset(Item)")).toBeNull();
    expect(elementTypeOf("Item")).toBeNull();
  });

  test("is anchored, so a union type is not mistaken for a container", () => {
    expect(elementTypeOf("array(Item)|int")).toBeNull();
    expect(elementTypeOf("int|array(Item)")).toBeNull();
  });
});
