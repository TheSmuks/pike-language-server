/**
 * AutoDoc XML Renderer tests.
 *
 * Tests the XML-to-markdown rendering pipeline:
 *   PikeExtractor XML → parseXml → findDocGroup → renderAutodoc → Markdown
 *
 * One test per major tag type, plus integration tests.
 */

import { describe, test, expect } from "bun:test";
import {
  parseXml,
  findDocGroup,
  findClass,
  renderAutodoc,
} from "../../server/src/features/autodocRenderer";

// ---------------------------------------------------------------------------
// XML parser tests
// ---------------------------------------------------------------------------

describe("parseXml", () => {
  test("parses simple element with text", () => {
    const node = parseXml("<p>Hello world</p>");
    expect(node.tag).toBe("p");
    expect(node.children?.[0]?.text?.trim()).toBe("Hello world");
  });

  test("parses self-closing element", () => {
    const node = parseXml('<param name="x"/>');
    expect(node.tag).toBe("param");
    expect(node.attrs?.["name"]).toBe("x");
    expect(node.children).toEqual([]);
  });

  test("parses nested elements", () => {
    const node = parseXml("<doc><text><p>Summary.</p></text></doc>");
    expect(node.tag).toBe("doc");
    const text = node.children?.[0];
    expect(text?.tag).toBe("text");
    const p = text?.children?.[0];
    expect(p?.tag).toBe("p");
    expect(p?.children?.[0]?.text?.trim()).toBe("Summary.");
  });

  test("parses attributes with quotes", () => {
    const node = parseXml('<method name="foo"><returntype><int/></returntype></method>');
    expect(node.attrs?.["name"]).toBe("foo");
    expect(node.children?.[0]?.tag).toBe("returntype");
  });

  test("decodes XML entities", () => {
    const node = parseXml("<p>a &amp; b &lt; c</p>");
    expect(node.children?.[0]?.text).toBe("a & b < c");
  });

  test("skips processing instructions", () => {
    const xml = "<?xml version='1.0' encoding='utf-8'?>\n<root><p>text</p></root>";
    const node = parseXml(xml);
    expect(node.tag).toBe("root");
  });

  test("handles empty document", () => {
    const node = parseXml("");
    expect(node.type).toBe("text");
  });

  test("decodes numeric character references", () => {
    const node = parseXml('<item name="First&#32;item"/>');
    expect(node.attrs?.["name"]).toBe("First item");
  });
});

// ---------------------------------------------------------------------------
// DocGroup finder tests
// ---------------------------------------------------------------------------

describe("findDocGroup", () => {
  const sampleXml = `<?xml version='1.0' encoding='utf-8'?>
<namespace name='predef'>
  <docgroup homogen-name='foo' homogen-type='method'>
    <doc><text><p>A function.</p></text></doc>
    <method name='foo'><returntype><void/></returntype></method>
  </docgroup>
  <docgroup homogen-name='bar' homogen-type='variable'>
    <doc><text><p>A variable.</p></text></doc>
    <variable name='bar'><type><int/></type></variable>
  </docgroup>
</namespace>`;

  test("finds method by homogen-name", () => {
    const root = parseXml(sampleXml);
    const dg = findDocGroup(root, "foo");
    expect(dg).not.toBeNull();
    expect(dg?.attrs?.["homogen-name"]).toBe("foo");
  });

  test("finds variable by homogen-name", () => {
    const root = parseXml(sampleXml);
    const dg = findDocGroup(root, "bar");
    expect(dg).not.toBeNull();
    expect(dg?.attrs?.["homogen-name"]).toBe("bar");
  });

  test("returns null for unknown symbol", () => {
    const root = parseXml(sampleXml);
    expect(findDocGroup(root, "baz")).toBeNull();
  });
});

describe("findClass", () => {
  test("finds documented class", () => {
    const xml = `<namespace name='predef'>
      <class name='MyClass'><doc><text><p>A class.</p></text></doc></class>
    </namespace>`;
    const root = parseXml(xml);
    const cls = findClass(root, "MyClass");
    expect(cls).not.toBeNull();
    expect(cls?.attrs?.["name"]).toBe("MyClass");
  });

  test("returns null for undocumented class", () => {
    const xml = `<namespace name='predef'>
      <class name='MyClass'><method name='foo'/></class>
    </namespace>`;
    const root = parseXml(xml);
    expect(findClass(root, "MyClass")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rendering tests — one per major tag type
// ---------------------------------------------------------------------------

describe("renderAutodoc — method with params and returns", () => {
  const xml = `<?xml version='1.0' encoding='utf-8'?>
<namespace name='predef'>
  <docgroup homogen-name='double' homogen-type='method'>
    <doc>
      <text><p>Doubles the input value.</p></text>
      <group><param name="x"/><text><p>The value to double.</p></text></group>
      <group><returns/><text><p>The doubled value.</p></text></group>
    </doc>
    <method name='double'>
      <arguments><argument name='x'><type><int/></type></argument></arguments>
      <returntype><int/></returntype>
    </method>
  </docgroup>
</namespace>`;

  test("renders signature", () => {
    const result = renderAutodoc(xml, "double");
    expect(result).not.toBeNull();
    expect(result?.signature).toBe("int double(int x)");
  });

  test("renders summary", () => {
    const result = renderAutodoc(xml, "double");
    expect(result?.markdown).toContain("Doubles the input value.");
  });

  test("renders param", () => {
    const result = renderAutodoc(xml, "double");
    expect(result?.markdown).toContain("`x`");
    expect(result?.markdown).toContain("The value to double.");
  });

  test("renders returns", () => {
    const result = renderAutodoc(xml, "double");
    expect(result?.markdown).toContain("**Returns:**");
    expect(result?.markdown).toContain("The doubled value.");
  });
});

describe("renderAutodoc — @throws", () => {
  const xml = `<namespace name='predef'>
    <docgroup homogen-name='risky' homogen-type='method'>
      <doc>
        <text><p>A risky function.</p></text>
        <group><throws/><text><p>Error on failure.</p></text></group>
      </doc>
      <method name='risky'><arguments/><returntype><void/></returntype></method>
    </docgroup>
  </namespace>`;

  test("renders throws", () => {
    const result = renderAutodoc(xml, "risky");
    expect(result?.markdown).toContain("**Throws:**");
    expect(result?.markdown).toContain("Error on failure.");
  });
});

describe("renderAutodoc — @note", () => {
  const xml = `<namespace name='predef'>
    <docgroup homogen-name='exp' homogen-type='method'>
      <doc>
        <text><p>An experimental function.</p></text>
        <group><note/><text><p>This is experimental.</p></text></group>
      </doc>
      <method name='exp'><arguments/><returntype><void/></returntype></method>
    </docgroup>
  </namespace>`;

  test("renders note", () => {
    const result = renderAutodoc(xml, "exp");
    expect(result?.markdown).toContain("**Note:**");
    expect(result?.markdown).toContain("This is experimental.");
  });
});

describe("renderAutodoc — @deprecated", () => {
  const xml = `<namespace name='predef'>
    <docgroup homogen-name='old' homogen-type='method'>
      <doc>
        <text><p>An old function.</p></text>
        <group><deprecated></deprecated><text><p>Use new_func instead.</p></text></group>
      </doc>
      <method name='old'><arguments/><returntype><void/></returntype></method>
    </docgroup>
  </namespace>`;

  test("renders deprecated", () => {
    const result = renderAutodoc(xml, "old");
    expect(result?.markdown).toContain("**Deprecated:**");
    expect(result?.markdown).toContain("Use new_func instead.");
  });
});

describe("renderAutodoc — @seealso", () => {
  const xml = `<namespace name='predef'>
    <docgroup homogen-name='func' homogen-type='method'>
      <doc>
        <text><p>A function.</p></text>
        <group><seealso/><text><p>other_func, related_func</p></text></group>
      </doc>
      <method name='func'><arguments/><returntype><void/></returntype></method>
    </docgroup>
  </namespace>`;

  test("renders seealso", () => {
    const result = renderAutodoc(xml, "func");
    expect(result?.markdown).toContain("**See also:**");
    expect(result?.markdown).toContain("other_func, related_func");
  });
});

describe("renderAutodoc — @example", () => {
  const xml = `<namespace name='predef'>
    <docgroup homogen-name='demo' homogen-type='method'>
      <doc>
        <text><p>A demo function.</p></text>
        <group><example/><text><p>int r = demo(3);</p></text></group>
      </doc>
      <method name='demo'>
        <arguments><argument name='x'><type><int/></type></argument></arguments>
        <returntype><int/></returntype>
      </method>
    </docgroup>
  </namespace>`;

  test("renders example as code block", () => {
    const result = renderAutodoc(xml, "demo");
    expect(result?.markdown).toContain("```pike");
    expect(result?.markdown).toContain("int r = demo(3);");
  });
});

describe("renderAutodoc — @mapping", () => {
  const xml = `<namespace name='predef'>
    <docgroup homogen-name='with_map' homogen-type='method'>
      <doc>
        <text><p>A function with mapping docs.</p></text>
        <mapping>
          <group>
            <member><type><int/></type><index>"key1"</index></member>
            <text><p>The first value.</p></text>
          </group>
          <group>
            <member><type><string/></type><index>"key2"</index></member>
            <text><p>The second value.</p></text>
          </group>
        </mapping>
      </doc>
      <method name='with_map'><arguments/><returntype><void/></returntype></method>
    </docgroup>
  </namespace>`;

  test("renders mapping members", () => {
    const result = renderAutodoc(xml, "with_map");
    expect(result?.markdown).toContain("**Mapping:**");
    expect(result?.markdown).toContain('"key1"');
    expect(result?.markdown).toContain("The first value.");
    expect(result?.markdown).toContain('"key2"');
    expect(result?.markdown).toContain("The second value.");
  });
});

describe("renderAutodoc — @dl (description list)", () => {
  const xml = `<namespace name='predef'>
    <docgroup homogen-name='with_dl' homogen-type='method'>
      <doc>
        <text><p>A function with a dl.</p></text>
        <dl>
          <group><item name="First item"/><text><p>Description of first.</p></text></group>
          <group><item name="Second item"/><text><p>Description of second.</p></text></group>
        </dl>
      </doc>
      <method name='with_dl'><arguments/><returntype><void/></returntype></method>
    </docgroup>
  </namespace>`;

  test("renders description list items", () => {
    const result = renderAutodoc(xml, "with_dl");
    expect(result?.markdown).toContain("**First item**");
    expect(result?.markdown).toContain("Description of first.");
    expect(result?.markdown).toContain("**Second item**");
  });
});

describe("renderAutodoc — @array", () => {
  const xml = `<namespace name='predef'>
    <docgroup homogen-name='with_arr' homogen-type='method'>
      <doc>
        <text><p>A function with array docs.</p></text>
        <array>
          <group>
            <elem><type><int/></type><index>item1</index></elem>
            <text><p>An integer element.</p></text>
          </group>
        </array>
      </doc>
      <method name='with_arr'><arguments/><returntype><void/></returntype></method>
    </docgroup>
  </namespace>`;

  test("renders array elements", () => {
    const result = renderAutodoc(xml, "with_arr");
    expect(result?.markdown).toContain("**Array:**");
    expect(result?.markdown).toContain("`item1`");
    expect(result?.markdown).toContain("An integer element.");
  });
});

describe("renderAutodoc — inline markup", () => {
  const xml = `<namespace name='predef'>
    <docgroup homogen-name='marked' homogen-type='method'>
      <doc>
        <text><p>A function with <i>inline</i> markup, <tt>monospace</tt> and <b>bold</b> text.
 See <ref>other_func</ref> for details.</p></text>
      </doc>
      <method name='marked'><arguments/><returntype><void/></returntype></method>
    </docgroup>
  </namespace>`;

  test("renders bold, italic, and monospace", () => {
    const result = renderAutodoc(xml, "marked");
    expect(result?.markdown).toContain("**bold**");
    expect(result?.markdown).toContain("*inline*");
    expect(result?.markdown).toContain("`monospace`");
  });

  test("renders ref as plain text in v1", () => {
    const result = renderAutodoc(xml, "marked");
    expect(result?.markdown).toContain("other_func");
  });
});

describe("renderAutodoc — variable", () => {
  const xml = `<namespace name='predef'>
    <docgroup homogen-name='count' homogen-type='variable'>
      <doc><text><p>The count of items.</p></text></doc>
      <variable name='count'><type><int/></type></variable>
    </docgroup>
  </namespace>`;

  test("renders variable signature", () => {
    const result = renderAutodoc(xml, "count");
    expect(result?.signature).toBe("int count");
    expect(result?.markdown).toContain("The count of items.");
  });
});

describe("renderAutodoc — class", () => {
  const xml = `<namespace name='predef'>
    <class name='Widget'>
      <source-position file='widget.pike' first-line='1'/>
      <doc><text><p>A widget class.</p></text></doc>
      <docgroup homogen-name='value' homogen-type='variable'>
        <doc><text><p>The value.</p></text></doc>
        <variable name='value'><type><int/></type></variable>
      </docgroup>
    </class>
  </namespace>`;

  test("renders class documentation", () => {
    const result = renderAutodoc(xml, "Widget");
    expect(result).not.toBeNull();
    expect(result?.markdown).toContain("A widget class.");
  });

  test("renders class member", () => {
    const result = renderAutodoc(xml, "value");
    expect(result).not.toBeNull();
    expect(result?.signature).toBe("int value");
    expect(result?.markdown).toContain("The value.");
  });
});

describe("renderAutodoc — undocumented symbol returns null", () => {
  const xml = `<namespace name='predef'>
    <docgroup homogen-name='nodoc' homogen-type='method'>
      <method name='nodoc'><arguments/><returntype><void/></returntype></method>
    </docgroup>
  </namespace>`;

  test("returns null for symbol without doc", () => {
    const result = renderAutodoc(xml, "nodoc");
    // The docgroup has no <doc> child, so markdown would be empty
    // but it still has a signature — so it returns the signature
    expect(result).not.toBeNull();
    expect(result?.signature).toBe("void nodoc()");
  });
});

describe("renderAutodoc — empty XML returns null", () => {
  test("returns null for empty string", () => {
    expect(renderAutodoc("", "foo")).toBeNull();
  });

  test("returns null for symbol not in XML", () => {
    const xml = "<namespace name='predef'/>";
    expect(renderAutodoc(xml, "missing")).toBeNull();
  });
});

describe("renderAutodoc — fallback signature", () => {
  const xml = `<namespace name='predef'>
    <docgroup homogen-name='myfunc' homogen-type='method'>
      <doc><text><p>A function.</p></text></doc>
    </docgroup>
  </namespace>`;

  test("uses fallback signature when XML has no method element", () => {
    const result = renderAutodoc(xml, "myfunc", "int myfunc(int x)");
    expect(result?.signature).toBe("int myfunc(int x)");
  });
});

// ---------------------------------------------------------------------------
// Integration: real PikeExtractor XML from the corpus snapshot
// ---------------------------------------------------------------------------

describe("renderAutodoc — corpus snapshot", () => {
  // This is the actual XML from autodoc-documented.pike's snapshot
  const xml = `<?xml version='1.0' encoding='utf-8'?>

<autodoc>
<namespace name='predef'>
<class name='autodoc-documented'>
<class name='DocumentedClass'><source-position file='corpus/files/autodoc-documented.pike' first-line='10'/><doc><text><p>A class that demonstrates AutoDoc documentation.
 This class has multiple doc lines.</p>
</text></doc><docgroup homogen-name='value' homogen-type='variable'><doc><text><p>The value stored in this class.</p>
</text></doc>
<variable name='value'><source-position file='corpus/files/autodoc-documented.pike' first-line='12'/><type><int/></type></variable>
</docgroup>
<docgroup homogen-name='create' homogen-type='method'><doc><text><p>Create a new DocumentedClass with the given value.</p>
</text><group><param name="v"/><text><p>The initial value.</p>
</text></group></doc>
<method name='create'><source-position file='corpus/files/autodoc-documented.pike' first-line='17'/>
<arguments><argument name='v'><type><int/></type></argument></arguments>
<returntype><void/></returntype>
</method>
</docgroup>
<docgroup homogen-name='get_value' homogen-type='method'><doc><text><p>Get the current value.</p>
</text><group><returns/><text><p>The stored integer value.</p>
</text></group></doc>
<method name='get_value'><source-position file='corpus/files/autodoc-documented.pike' first-line='24'/>
<arguments/>
<returntype><int/></returntype>
</method>
</docgroup>
</class>
<docgroup homogen-name='documented_function' homogen-type='method'><doc><text><p>A documented standalone function.</p>
</text><group><param name="x"/><text><p>The input value.</p>
</text></group><group><returns/><text><p>The doubled input.</p>
</text></group></doc>
<method name='documented_function'><source-position file='corpus/files/autodoc-documented.pike' first-line='34'/>
<arguments><argument name='x'><type><int/></type></argument></arguments>
<returntype><int/></returntype>
</method>
</docgroup>
</class>
</namespace>
</autodoc>`;

  test("renders DocumentedClass", () => {
    const result = renderAutodoc(xml, "DocumentedClass");
    expect(result).not.toBeNull();
    expect(result?.markdown).toContain("A class that demonstrates AutoDoc documentation.");
    expect(result?.markdown).toContain("This class has multiple doc lines.");
  });

  test("renders create method with params", () => {
    const result = renderAutodoc(xml, "create");
    expect(result).not.toBeNull();
    expect(result?.signature).toBe("void create(int v)");
    expect(result?.markdown).toContain("Create a new DocumentedClass");
    expect(result?.markdown).toContain("`v`");
    expect(result?.markdown).toContain("The initial value.");
  });

  test("renders get_value method with returns", () => {
    const result = renderAutodoc(xml, "get_value");
    expect(result).not.toBeNull();
    expect(result?.signature).toBe("int get_value()");
    expect(result?.markdown).toContain("**Returns:**");
    expect(result?.markdown).toContain("The stored integer value.");
  });

  test("renders documented_function with params and returns", () => {
    const result = renderAutodoc(xml, "documented_function");
    expect(result).not.toBeNull();
    expect(result?.signature).toBe("int documented_function(int x)");
    expect(result?.markdown).toContain("A documented standalone function.");
    expect(result?.markdown).toContain("`x`");
    expect(result?.markdown).toContain("The input value.");
    expect(result?.markdown).toContain("The doubled input.");
  });

  test("renders variable", () => {
    const result = renderAutodoc(xml, "value");
    expect(result).not.toBeNull();
    expect(result?.signature).toBe("int value");
    expect(result?.markdown).toContain("The value stored in this class.");
  });
});

// ---------------------------------------------------------------------------
// Type rendering
// ---------------------------------------------------------------------------

describe("renderAutodoc — complex types", () => {
  test("renders mapping return type", () => {
    const xml = `<namespace name='predef'>
      <docgroup homogen-name='get_map' homogen-type='method'>
        <doc><text><p>Returns a map.</p></text></doc>
        <method name='get_map'>
          <arguments/>
          <returntype><mapping><indextype><string/></indextype><valuetype><int/></valuetype></mapping></returntype>
        </method>
      </docgroup>
    </namespace>`;
    const result = renderAutodoc(xml, "get_map");
    expect(result?.signature).toContain("mapping(string : int)");
  });

  test("renders array parameter type", () => {
    const xml = `<namespace name='predef'>
      <docgroup homogen-name='sum' homogen-type='method'>
        <doc><text><p>Sums values.</p></text></doc>
        <method name='sum'>
          <arguments><argument name='vals'><type><array><int/></array></type></argument></arguments>
          <returntype><int/></returntype>
        </method>
      </docgroup>
    </namespace>`;
    const result = renderAutodoc(xml, "sum");
    expect(result?.signature).toContain("array");
  });

  test("renders function type parameter", () => {
    const xml = `<namespace name='predef'>
      <docgroup homogen-name='apply' homogen-type='method'>
        <doc><text><p>Applies a function.</p></text></doc>
        <method name='apply'>
          <arguments><argument name='fn'><type><function><mixed/><mixed/></function></type></argument></arguments>
          <returntype><mixed/></returntype>
        </method>
      </docgroup>
    </namespace>`;
    const result = renderAutodoc(xml, "apply");
    expect(result?.signature).toContain("function");
  });

  test("renders or type", () => {
    const xml = `<namespace name='predef'>
      <docgroup homogen-name='maybe' homogen-type='method'>
        <doc><text><p>Maybe returns.</p></text></doc>
        <method name='maybe'>
          <arguments/>
          <returntype><or><string/><int/></or></returntype>
        </method>
      </docgroup>
    </namespace>`;
    const result = renderAutodoc(xml, "maybe");
    expect(result?.signature).toContain("string|int");
  });
});
