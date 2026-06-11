import { beforeAll, describe, expect, test } from "bun:test";
import { initParser, parse } from "../../server/src/parser";
import { getParseDiagnostics } from "../../server/src/features/diagnostics";

describe("parse diagnostics", () => {
  beforeAll(async () => {
    await initParser();
  });

  test("does not flag multiline hash strings as syntax errors", () => {
    const uri = "file:///parse-diagnostics-hash-string.pike";
    const source = [
      "int main() {",
      "  string text = #\"Formatting examples:",
      "Left adjusted  [%-10d]",
      "Right adjusted [%10d]",
      "\";",
      "  return sizeof(text);",
      "}",
      "",
    ].join("\n");

    const tree = parse(source, uri);
    const diagnostics = getParseDiagnostics(tree, source.split("\n"));

    expect(tree.rootNode.hasError).toBe(false);
    expect(diagnostics).toEqual([]);
  });
});
