/**
 * Instance-member completion visibility.
 *
 * The oracle is the real Pike runtime (8.0.1116, verified with .pike/.pmod
 * programs): `->` and `.` never expose a protected or private member, in ANY
 * context. `c->prot` is UNDEFINED and calling it throws — and that is just as
 * true inside a method of the declaring class, whether the receiver is `this`
 * or another instance of the same class. `indices(this)` inside the class
 * lists the public members only. Inherited protected is no different: the
 * bare call `prot()` works in a subclass, `this->prot()` is NULL. For `.` it
 * is a compile error instead of a runtime 0, self-reference included.
 *
 * Lexical reach — the bare identifier — does vary with position, but that is
 * scope completion, not member access, and is covered elsewhere. Member-access
 * completion must offer exactly the public members.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestServer, waitForIndexed, TestServer } from "./helpers";
import { resetCompletionCache } from "../../server/src/features/completionTrigger";

const CLASS_SRC = [
  "class C {",
  "  int pub = 1;",
  "  protected int prot = 2;",
  "  private int priv = 3;",
  "  protected int pfn() { return 4; }",
  "  private {",
  "    int blk_priv;",
  "  }",
  "  int pubfn() { return 5; }",
  "}",
].join("\n");

async function completeAt(
  server: TestServer,
  uri: string,
  src: string,
  line: number,
  character: number,
): Promise<string[]> {
  const opened = server.openDoc(uri, src);
  await waitForIndexed(server, [opened]);
  const result = (await server.client.sendRequest("textDocument/completion", {
    textDocument: { uri: opened },
    position: { line, character },
  })) as { items: Array<{ label: string }> } | Array<{ label: string }> | null;
  if (!result) return [];
  const items = Array.isArray(result) ? result : result.items;
  return items.map((i) => i.label);
}

describe("instance member completion follows Pike visibility", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer();
    resetCompletionCache();
  });

  afterAll(async () => {
    await server.teardown();
  });

  test("outside the class, protected and private members are hidden", async () => {
    const src = [
      CLASS_SRC,
      "void user() {",
      "  C c = C();",
      "  c->",
      "}",
    ].join("\n");
    const labels = await completeAt(
      server, "file:///test/vis-external.pike", src, 12, 5,
    );

    expect(labels).toContain("pub");
    expect(labels).toContain("pubfn");
    expect(labels).not.toContain("prot");
    expect(labels).not.toContain("priv");
    expect(labels).not.toContain("pfn");
    expect(labels).not.toContain("blk_priv");
  });

  // The internal and subclass probes complete on a well-formed member
  // expression (`o->pub;`, cursor right after the arrow): a dangling `o->`
  // inside a class body collapses the whole class into an ERROR node, so
  // mid-typing there resolves no receiver at all — a pre-existing grammar
  // recovery limit, separate from visibility.

  test("inside the declaring class, another instance still hides non-publics", async () => {
    const src = [
      "class C {",
      "  int pub = 1;",
      "  protected int prot = 2;",
      "  private int priv = 3;",
      "  int m(C o) {",
      "    o->pub;",
      "  }",
      "}",
    ].join("\n");
    const labels = await completeAt(
      server, "file:///test/vis-internal.pike", src, 5, 7,
    );

    // Oracle: `o->prot()` from a method of C throws "Attempt to call the
    // NULL-value" — being inside the declaring class buys the arrow nothing.
    expect(labels).toContain("pub");
    expect(labels).not.toContain("prot");
    expect(labels).not.toContain("priv");
  });

  test("inside a subclass, inherited protected is hidden from the arrow too", async () => {
    const src = [
      CLASS_SRC,
      "class Sub {",
      "  inherit C;",
      "  void m(C o) {",
      "    o->pub;",
      "  }",
      "}",
    ].join("\n");
    const labels = await completeAt(
      server, "file:///test/vis-subclass.pike", src, 13, 7,
    );

    // Oracle: `this->prot()` in a subclass of C is NULL even though the bare
    // call `prot()` compiles and runs.
    expect(labels).toContain("pub");
    expect(labels).not.toContain("prot");
    expect(labels).not.toContain("pfn");
    expect(labels).not.toContain("priv");
    expect(labels).not.toContain("blk_priv");
  });
});
