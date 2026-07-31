/**
 * The generator's harvesting rules, tested without a Roxen checkout.
 *
 * roxen-index.json is generated from a tree most machines do not have, so the
 * shipped data is asserted in roxenIndex.test.ts and the rules that produced
 * it are asserted here, against sources small enough to read. What matters is
 * that each rule is derived from the source it reads: the exclusion set comes
 * out of prototypes.pike's own `ignore_identifiers`, and the globals come out
 * of the `add_constant` calls rather than from a list anyone maintains.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { initParser } from "../../server/src/parser";
import {
  parsePikeDeclarations,
  extractAddConstantCalls,
  parseIgnoreIdentifiers,
  isExported,
  type DeclInfo,
} from "../../scripts/roxen-declarations";

beforeAll(async () => {
  await initParser();
});

const byName = (decls: DeclInfo[], name: string): DeclInfo | undefined =>
  decls.find((d) => d.name === name);

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

describe("parsing declarations out of a prototype", () => {
  const SOURCE = `constant cvs_version = "$Id: abc $";
mapping(string:array(int)) error_log = ([]);
private string _hidden;
protected int _also_hidden;

mapping(string:mixed)|int(-1..0) find_file(string path, RequestID id)
{
  return 0;
}

string query_location();

class RoxenModule
{
  constant is_module = 1;
  LocaleString module_name;
  string real_file(string f, RequestID id);
}
`;

  const parsed = (): ReturnType<typeof parsePikeDeclarations> =>
    parsePikeDeclarations(SOURCE, "file:///proto.pike");

  test("renders a function down to its parameter list, dropping the body", () => {
    const decl = byName(parsed().fileScope, "find_file");
    expect(decl?.signature).toBe(
      "mapping(string:mixed)|int(-1..0) find_file(string path, RequestID id);",
    );
  });

  test("renders a bodiless prototype declaration the same way", () => {
    expect(byName(parsed().fileScope, "query_location")?.signature)
      .toBe("string query_location();");
  });

  test("drops a variable's initializer but keeps its type", () => {
    expect(byName(parsed().fileScope, "error_log")?.signature)
      .toBe("mapping(string:array(int)) error_log;");
  });

  test("marks private and protected declarations as unexported", () => {
    const scope = parsed().fileScope;
    expect(isExported(byName(scope, "_hidden")!)).toBe(false);
    expect(isExported(byName(scope, "_also_hidden")!)).toBe(false);
    expect(isExported(byName(scope, "find_file")!)).toBe(true);
  });

  test("collects a top-level class's members separately from file scope", () => {
    const members = parsed().classes.get("RoxenModule");
    expect(members?.map((m) => m.name)).toEqual(["is_module", "module_name", "real_file"]);
    // A class member is not also a file-scope declaration; conflating the two
    // would put names in bare scope that Roxen code cannot write bare.
    expect(byName(parsed().fileScope, "is_module")).toBeUndefined();
  });

  test("keeps a class header off the doc block Roxen writes above the brace", () => {
    const withDoc = `class RequestID
//! @appears RequestID
//! The request information object.
{
  int misc;
}
`;
    const decl = byName(parsePikeDeclarations(withDoc, "file:///d.pike").fileScope, "RequestID");
    expect(decl?.signature).toBe("class RequestID");
  });
});

// ---------------------------------------------------------------------------
// Injected globals
// ---------------------------------------------------------------------------

describe("finding add_constant calls", () => {
  test("reads the name and the value expression", () => {
    const calls = extractAddConstantCalls(`add_constant("report_fatal", report_fatal);`);
    expect(calls).toEqual([{ name: "report_fatal", valueExpr: "report_fatal" }]);
  });

  test("survives a lambda value, and keeps finding calls after it", () => {
    // A regular expression stopping at the first `)` would end the match inside
    // the lambda and lose every call that follows it.
    const calls = extractAddConstantCalls(
      `add_constant("gethostname", lambda() { return "localhost"; });\n` +
      `add_constant("roxen_path", roxen_path);`,
    );
    expect(calls.map((c) => c.name)).toEqual(["gethostname", "roxen_path"]);
    expect(calls[1]!.valueExpr).toBe("roxen_path");
  });

  test("is not fooled by a parenthesis inside a string or a comment", () => {
    const calls = extractAddConstantCalls(
      `add_constant("quoted", "a ) string");\n` +
      `add_constant("commented", /* ) */ value); // )\n` +
      `add_constant("after", after);`,
    );
    expect(calls.map((c) => c.name)).toEqual(["quoted", "commented", "after"]);
    expect(calls[0]!.valueExpr).toBe(`"a ) string"`);
  });

  test("finds nothing where there is nothing to find", () => {
    expect(extractAddConstantCalls("int main() { return 0; }")).toEqual([]);
  });
});

describe("reading prototypes.pike's own exclusion list", () => {
  test("takes the names out of the multiset the file declares", () => {
    const ignored = parseIgnoreIdentifiers(
      `// Externally visible identifiers in this file that shouldn't be added\n` +
      `constant ignore_identifiers = (<\n  "cvs_version", "Roxen", "ignore_identifiers"\n>);\n`,
    );
    expect([...ignored].sort()).toEqual(["Roxen", "cvs_version", "ignore_identifiers"]);
  });

  test("excludes nothing when the file declares no such list", () => {
    expect(parseIgnoreIdentifiers("constant cvs_version = \"x\";").size).toBe(0);
  });
});
