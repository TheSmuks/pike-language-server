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
      return (node.children ?? []).map(renderType).join("");
    case "int": {
      // Check for range constraints
      const children = node.children ?? [];
      const hasRange = children.some((c) => c.type === "element" && (c.tag === "min" || c.tag === "max"));
      if (hasRange) {
        const minEl = children.find((c) => c.type === "element" && c.tag === "min");
        const maxEl = children.find((c) => c.type === "element" && c.tag === "max");
        const minVal = minEl ? (minEl.children ?? []).map((c) => c.text?.trim() ?? "").join("") : "";
        const maxVal = maxEl ? (maxEl.children ?? []).map((c) => c.text?.trim() ?? "").join("") : "";
        if (minVal && maxVal) return `int(${minVal}..${maxVal})`;
      }
      return "int";
    }
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
    case "object": {
      const cls = node.attrs?.["class"] ?? node.children?.map(renderType).join("");
      return cls ? `object(${cls})` : "object";
    }
    case "array": {
      const inner = (node.children ?? [])
        .filter((c) => c.type === "element" && c.tag !== "int" && c.tag !== "string")
        .map(renderType)
        .join("");
      return inner && inner !== "mixed" ? `array(${inner})` : "array";
    }
    case "mapping": {
      const parts = (node.children ?? []).map(renderType);
      if (parts.length >= 2) return `mapping(${parts[0]} : ${parts[1]})`;
      return "mapping";
    }
    case "multiset": {
      const inner = (node.children ?? []).map(renderType).join("");
      return inner ? `multiset(${inner})` : "multiset";
    }
    case "function": {
      const parts = (node.children ?? []).map(renderType);
      if (parts.length >= 2) {
        const args = parts.slice(0, -1).join(", ");
        const ret = parts[parts.length - 1];
        return `function(${args} : ${ret})`;
      }
      return "function";
    }
    case "program": {
      const inner = (node.children ?? []).map(renderType).join("");
      return inner ? `program(${inner})` : "program";
    }
    case "varargs": {
      const inner = (node.children ?? []).map(renderType).join("");
      return `${inner} ...`;
    }
    case "or": {
      const parts = (node.children ?? []).map(renderType);
      return parts.join("|");
    }
    case "optional":
      return (node.children ?? []).map(renderType).join("");
    case "attribute":
      return (node.children ?? []).map(renderType).join("");
    case "indextype":
    case "valuetype":
      return (node.children ?? []).map(renderType).join("");
    case "min":
    case "max":
      return ""; // range limits — skip for hover
    default:
      return (node.children ?? []).map(renderType).join("");
  }
}

// ---------------------------------------------------------------------------
// Signature rendering
// ---------------------------------------------------------------------------

/**
 * Extract the method/variable/class signature from its XML element.
 */
export function renderSignature(node: XmlNode): string {
  if (node.type !== "element") return "";

  switch (node.tag) {
    case "method": {
      const name = node.attrs?.["name"] ?? "";
      const args: string[] = [];
      const retType: string[] = [];

      for (const child of node.children ?? []) {
        if (child.type === "element") {
          if (child.tag === "arguments") {
            for (const arg of child.children ?? []) {
              if (arg.type === "element" && arg.tag === "argument") {
                const argName = arg.attrs?.["name"] ?? "";
                const argType = (arg.children ?? [])
                  .filter((c) => c.type === "element" && c.tag === "type")
                  .map(renderType)
                  .join("");
                args.push(argType ? `${argType} ${argName}` : argName);
              }
            }
          } else if (child.tag === "returntype") {
            retType.push(renderType(child));
          }
        }
      }

      const ret = retType.join("") || "void";
      const params = args.join(", ");
      return `${ret} ${name}(${params})`;
    }

    case "variable": {
      const name = node.attrs?.["name"] ?? "";
      const varType = (node.children ?? [])
        .filter((c) => c.type === "element" && c.tag === "type")
        .map(renderType)
        .join("");
      return varType ? `${varType} ${name}` : name;
    }

    case "constant": {
      const name = node.attrs?.["name"] ?? "";
      return `constant ${name}`;
    }

    case "inherit": {
      const name = node.attrs?.["name"] ?? "";
      const cls = node.attrs?.["class"] ?? "";
      return cls ? `inherit ${cls} : ${name}` : `inherit ${name}`;
    }

    case "class": {
      const name = node.attrs?.["name"] ?? "";
      return `class ${name}`;
    }

    case "typedef": {
      const name = node.attrs?.["name"] ?? "";
      return `typedef ${name}`;
    }

    default:
      return "";
  }
}
