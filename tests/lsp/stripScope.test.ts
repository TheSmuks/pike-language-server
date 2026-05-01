import { describe, it, expect } from "bun:test";
import { stripScopeWrapper } from "../../server/src/util/stripScope";

describe("stripScopeWrapper", () => {
  it("strips a simple scope(0, ...) wrapper", () => {
    expect(stripScopeWrapper("scope(0,function(mixed|void...:mixed))"))
      .toBe("function(mixed|void...:mixed)");
  });

  it("strips a scope(1, ...) wrapper", () => {
    expect(stripScopeWrapper("scope(1,string)"))
      .toBe("string");
  });

  it("strips nested scope wrappers", () => {
    expect(stripScopeWrapper("scope(0,scope(1,string))"))
      .toBe("string");
  });

  it("strips deeply nested scope wrappers", () => {
    expect(stripScopeWrapper("scope(0,scope(1,scope(0,function(mixed:void))))"))
      .toBe("function(mixed:void)");
  });

  it("returns unchanged string when no scope wrapper", () => {
    expect(stripScopeWrapper("function(string,mixed...:string)"))
      .toBe("function(string,mixed...:string)");
  });

  it("handles scope with complex inner types", () => {
    expect(stripScopeWrapper("scope(0,__attribute__(\"deprecated\",function(mixed...:mixed)))"))
      .toBe("__attribute__(\"deprecated\",function(mixed...:mixed))");
  });

  it("handles scope around an overload union", () => {
    expect(stripScopeWrapper("scope(0,function(string,mixed...:string) | function(array,mixed...:array))"))
      .toBe("function(string,mixed...:string) | function(array,mixed...:array)");
  });

  it("returns plain type strings unchanged", () => {
    expect(stripScopeWrapper("string")).toBe("string");
  });

  it("handles scope with no inner parens", () => {
    expect(stripScopeWrapper("scope(0,int)")).toBe("int");
  });
});
