// ---------------------------------------------------------------------------
// xml-renderer-types.ts: Type and signature rendering from AutoDoc XML
// Extracted from xml-renderer.ts to reduce file size.
// ---------------------------------------------------------------------------
import type { XmlNode } from './xmlParser';

// ---------------------------------------------------------------------------
// Type rendering (from <type> subtrees)
// ---------------------------------------------------------------------------

export function renderType(node: XmlNode): string {
  if (node.type === "text") return node.text?.trim() ?? "";

  switch (node.tag) {
    case "type":
      return renderChildrenTypes(node);
    case "int":
      return renderIntType(node);
    case "string":
      return "string";
    case "float":
      return "float";
    case "void":
      return "void";
    case "mixed":
      return "mixed";
    case "bool":
      return "bool";
    case "zero":
      return "zero";
    case "object":
      return renderObjectType(node);
    case "array":
      return renderArrayType(node);
    case "mapping":
      return renderMappingType(node);
    case "multiset":
      return renderMultisetType(node);
    case "function":
      return renderFunctionType(node);
    case "program":
      return renderProgramType(node);
    case "varargs":
      return renderVarargsType(node);
    case "or":
      return renderOrType(node);
    case "optional":
    case "attribute":
    case "indextype":
    case "valuetype":
      return renderChildrenTypes(node);
    case "min":
    case "max":
      return ""; // range limits — skip for hover
    default:
      return renderChildrenTypes(node);
  }
}

// ---------------------------------------------------------------------------
// Type rendering helpers
// ---------------------------------------------------------------------------

function renderChildrenTypes(node: XmlNode): string {
  return (node.children ?? []).map(renderType).join("");
}

function renderIntType(node: XmlNode): string {
  const children = node.children ?? [];
  const minEl = children.find((c) => c.type === "element" && c.tag === "min");
  const maxEl = children.find((c) => c.type === "element" && c.tag === "max");
  if (minEl && maxEl) {
    const minVal = (minEl.children ?? []).map((c) => c.text?.trim() ?? "").join("");
    const maxVal = (maxEl.children ?? []).map((c) => c.text?.trim() ?? "").join("");
    if (minVal && maxVal) return `int(${minVal}..${maxVal})`;
  }
  return "int";
}

function renderObjectType(node: XmlNode): string {
  const cls = node.attrs?.["class"] ?? node.children?.map(renderType).join("");
  return cls ? `object(${cls})` : "object";
}

function renderArrayType(node: XmlNode): string {
  const inner = (node.children ?? [])
    .filter((c) => c.type === "element" && c.tag !== "int" && c.tag !== "string")
    .map(renderType)
    .join("");
  return inner && inner !== "mixed" ? `array(${inner})` : "array";
}

function renderMappingType(node: XmlNode): string {
  const parts = (node.children ?? []).map(renderType);
  if (parts.length >= 2) return `mapping(${parts[0]} : ${parts[1]})`;
  return "mapping";
}

function renderMultisetType(node: XmlNode): string {
  const inner = (node.children ?? []).map(renderType).join("");
  return inner ? `multiset(${inner})` : "multiset";
}

function renderFunctionType(node: XmlNode): string {
  const parts = (node.children ?? []).map(renderType);
  if (parts.length >= 2) {
    const args = parts.slice(0, -1).join(", ");
    const ret = parts[parts.length - 1];
    return `function(${args} : ${ret})`;
  }
  return "function";
}

function renderProgramType(node: XmlNode): string {
  const inner = (node.children ?? []).map(renderType).join("");
  return inner ? `program(${inner})` : "program";
}

function renderVarargsType(node: XmlNode): string {
  const inner = (node.children ?? []).map(renderType).join("");
  return `${inner} ...`;
}

function renderOrType(node: XmlNode): string {
  return (node.children ?? []).map(renderType).join("|");
}

// ---------------------------------------------------------------------------
// Signature rendering
// ---------------------------------------------------------------------------

/** Extract arguments from an <arguments> element. */
function extractArguments(argNode: XmlNode): string[] {
  const args: string[] = [];
  for (const arg of argNode.children ?? []) {
    if (arg.type === "element" && arg.tag === "argument") {
      const argName = arg.attrs?.["name"] ?? "";
      const argType = (arg.children ?? [])
        .filter((c) => c.type === "element" && c.tag === "type")
        .map(renderType)
        .join("");
      args.push(argType ? `${argType} ${argName}` : argName);
    }
  }
  return args;
}

/**
 * Extract the method/variable/class signature from its XML element.
 */
export function renderSignature(node: XmlNode): string {
  if (node.type !== "element") return "";

  switch (node.tag) {
    case "method":   return renderMethodSignature(node);
    case "variable": return renderVariableSignature(node);
    case "constant": return renderConstantSignature(node);
    case "inherit":  return renderInheritSignature(node);
    case "class":    return renderClassSignature(node);
    case "typedef":  return renderTypedefSignature(node);
    default:         return "";
  }
}

function renderMethodSignature(node: XmlNode): string {
  const name = node.attrs?.["name"] ?? "";
  const args: string[] = [];
  const retType: string[] = [];

  for (const child of node.children ?? []) {
    if (child.type !== "element") continue;
    if (child.tag === "arguments") {
      args.push(...extractArguments(child));
    } else if (child.tag === "returntype") {
      retType.push(renderType(child));
    }
  }

  const ret = retType.join("") || "void";
  return `${ret} ${name}(${args.join(", ")})`;
}

function renderVariableSignature(node: XmlNode): string {
  const name = node.attrs?.["name"] ?? "";
  const varType = (node.children ?? [])
    .filter((c) => c.type === "element" && c.tag === "type")
    .map(renderType)
    .join("");
  return varType ? `${varType} ${name}` : name;
}

function renderConstantSignature(node: XmlNode): string {
  const name = node.attrs?.["name"] ?? "";
  return `constant ${name}`;
}

function renderInheritSignature(node: XmlNode): string {
  const name = node.attrs?.["name"] ?? "";
  const cls = node.attrs?.["class"] ?? "";
  return cls ? `inherit ${cls} : ${name}` : `inherit ${name}`;
}

function renderClassSignature(node: XmlNode): string {
  const name = node.attrs?.["name"] ?? "";
  return `class ${name}`;
}

function renderTypedefSignature(node: XmlNode): string {
  const name = node.attrs?.["name"] ?? "";
  return `typedef ${name}`;
}
