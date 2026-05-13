/**
 * Tree-sitter-based syntactic token provider.
 *
 * Provides syntax highlighting based purely on AST structure, without requiring
 * name resolution. This runs as a DocumentSemanticTokensProvider, feeding VSCode
 * a token stream derived from tree-sitter highlights.scm captures.
 *
 * The LSP's semantic token provider (which knows about declarations, references,
 * and resolved types) runs alongside and takes priority. Tree-sitter fills in
 * everything else — keywords, operators, types, literals — instantly without waiting
 * for project analysis.
 */

import * as vscode from "vscode";
import * as treeSitter from "web-tree-sitter";

/** Capture name → VSCode semantic token type string. */
const CAPTURE_TO_TOKEN_TYPE: Record<string, string> = {
  keyword: "keyword",
  type: "type",
  function: "function",
  variable: "variable",
  string: "string",
  number: "number",
  comment: "comment",
  operator: "operator",
  punctuation: "punctuation",
};

/** Capture name → VSCode semantic token modifier strings. */
const CAPTURE_TO_TOKEN_MODIFIER: Record<string, string[]> = {
  "keyword.modifier": ["modification"],
  "keyword.directive": ["modification"],
  "type.builtin": ["defaultLibrary"],
  "function.builtin": ["defaultLibrary"],
  "number.float": ["modification"],
  "comment.line": [],
  "comment.block": [],
  "comment.documentation": ["documentation"],
  "constant.builtin": ["readonly"],
};

/** All token types used in the legend. */
const TOKEN_TYPES = [
  "keyword",
  "type",
  "function",
  "variable",
  "string",
  "number",
  "comment",
  "operator",
  "punctuation",
] as const;

/** All token modifiers used in the legend. */
const TOKEN_MODIFIERS = [
  "modification",
  "defaultLibrary",
  "documentation",
  "readonly",
] as const;

/**
 * Maps a capture name (from highlights.scm) to VSCode token type and modifiers.
 *
 * Falls back to `variable` for unknown captures rather than silently dropping tokens.
 */
function mapCapture(name: string): {
  tokenType: string;
  tokenModifiers: string[];
} {
  if (name in CAPTURE_TO_TOKEN_MODIFIER) {
    return {
      tokenType:
        CAPTURE_TO_TOKEN_TYPE[name] ?? "variable",
      tokenModifiers: CAPTURE_TO_TOKEN_MODIFIER[name] ?? [],
    };
  }
  if (name in CAPTURE_TO_TOKEN_TYPE) {
    return {
      tokenType: CAPTURE_TO_TOKEN_TYPE[name],
      tokenModifiers: [],
    };
  }
  // Unknown capture — treat as variable
  return {
    tokenType: "variable",
    tokenModifiers: [],
  };
}

/** Legend for tree-sitter syntactic tokens. Separate from LSP semantic legend. */
const LEGEND = new vscode.SemanticTokensLegend(
  [...TOKEN_TYPES],
  [...TOKEN_MODIFIERS],
);

const HIGHLIGHTS_QUERY = `
; Keywords

[
  "if" "else" "for" "while" "do" "foreach" "switch" "case" "default"
  "break" "continue" "return"
  "catch" "gauge" "sscanf" "typeof" "lambda"
  "class" "enum" "typedef" "inherit" "import"
  "constant"
  "predef" "bits"
  "__attribute__" "__deprecated__"
  "__func__"
  ; Future reserved keywords
  "auto" "const"
] @keyword

; Modifiers
[
  "private" "protected" "public" "static" "extern"
  "inline" "local" "final" "variant" "optional"
  "global" "nomask"
] @keyword.modifier

; Type keywords
[
  "void" "mixed" "int" "float" "string" "array"
  "mapping" "multiset" "object" "program" "function"
] @type.builtin

; Literals
(integer_literal) @number
(float_literal) @number.float
(string_literal) @string

; Identifiers
(identifier) @variable
(identifier_expr (identifier) @variable)
(backtick_identifier) @function.builtin

; Function declarations
(function_decl
  name: (identifier) @function)

; Class/enum/typedef declarations
(class_decl
  name: (identifier) @type)
(enum_decl
  name: (identifier) @type)
(typedef_decl
  name: (identifier) @type)

; Type annotations
(type (basic_type) @type)
(parameter
  type: (type) @type)

; Operators
[
  "+" "-" "*" "/" "%"
  "==" "!=" ">" ">=" "<" "<="
  "<<" ">>"
  "&" "|" "^" "~"
  "&&" "||" "!"
  ".." "..."
  "->" "::" "->?" "[?"
  "=" "+=" "-=" "*=" "/=" "%=" "&=" "|=" "^=" "<<=" ">>="
  "++" "--"
] @operator

; Punctuation
["(" ")" "{" "}" "[" "]" "," ";" "." "@" "?" ":"] @punctuation.delimiter

; Comments
(line_comment) @comment.line
(block_comment) @comment.block
(autodoc_comment) @comment.documentation

; Preprocessor
(preprocessor_directive) @keyword.directive


; Built-in constants
[
  "this" "this_program"
  "__LINE__" "__FILE__" "__DATE__" "__TIME__" "__DIR__"
  "__VERSION__" "__MAJOR__" "__MINOR__" "__PIKE__"
  "__REAL_VERSION__" "__REAL_MAJOR__" "__REAL_MINOR__"
  "__BUILD__" "__REAL_BUILD__"
  "__AUTO_BIGNUM__" "__COUNTER__"
] @constant.builtin
`;

interface ParsedToken {
  line: number;
  startCol: number;
  endLine: number;
  endCol: number;
  tokenType: string;
  tokenModifiers: string[];
}

/**
 * Tree-sitter syntactic token provider.
 *
 * Loads web-tree-sitter WASM and the Pike grammar once at first use,
 * then parses each document and runs the highlights query to produce
 * semantic tokens.
 */
export class TreeSitterSyntacticProvider
  implements vscode.DocumentSemanticTokensProvider
{
  readonly legend: vscode.SemanticTokensLegend = LEGEND;

  private parser: treeSitter.Parser | null = null;
  private language: treeSitter.Language | null = null;
  private query: treeSitter.Query | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {
    // Kick off async init; first document request will await it.
    this.initPromise = this.#init();
  }

  /** Initialize web-tree-sitter WASM and load the Pike grammar. */
  async #init(): Promise<void> {
    try {
      console.log("[tree-sitter] step 1/4: Parser.init() — loading WASM runtime");
      // Parser.init() MUST be called before Language.load() or new Parser().
      // It initializes the Emscripten WASM module (C runtime) that Language.load
      // depends on via C.loadWebAssemblyModule().  Omitting this was the root cause
      // of "Cannot read properties of undefined (reading 'charAt')" and missing
      // syntax highlighting in v0.4.0.
      await treeSitter.Parser.init();
      console.log("[tree-sitter] step 1/4: Parser.init() complete");

      console.log("[tree-sitter] step 2/4: loading Pike grammar WASM");
      const lang = await treeSitter.Language.load(
        this.context.asAbsolutePath("server/tree-sitter-pike.wasm"),
      );
      this.language = lang;
      console.log("[tree-sitter] step 2/4: Pike grammar loaded");

      console.log("[tree-sitter] step 3/4: creating parser instance");
      this.parser = new treeSitter.Parser();
      this.parser.setLanguage(this.language);
      console.log("[tree-sitter] step 3/4: parser created");

      console.log("[tree-sitter] step 4/4: compiling highlights query");
      this.query = new treeSitter.Query(this.language, HIGHLIGHTS_QUERY);
      console.log("[tree-sitter] step 4/4: highlights query compiled — ready");
    } catch (err) {
      console.error("[tree-sitter] INIT FAILED:", err);
    }
  }

  async provideDocumentSemanticTokens(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): Promise<vscode.SemanticTokens | null> {
    try {
      if (this.initPromise) {
        await this.initPromise;
        this.initPromise = null;
      }

      if (!this.parser || !this.query) {
        return null;
      }

      const text = document.getText();
      const tree = this.parser.parse(text);
      if (!tree) {
        return null;
      }

      const rootNode = tree.rootNode;
      const captures = this.query.captures(rootNode);
      const tokens: ParsedToken[] = [];

      for (const capture of captures) {
        const node = capture.node;
        const { startPosition, endPosition } = node;

        const { tokenType, tokenModifiers } = mapCapture(capture.name);
        tokens.push({
          line: startPosition.row,
          startCol: startPosition.column,
          endLine: endPosition.row,
          endCol: endPosition.column,
          tokenType,
          tokenModifiers,
        });
      }

      // Sort by start position so tokens are in document order
      tokens.sort((a, b) => {
        const lineDiff = a.line - b.line;
        if (lineDiff !== 0) return lineDiff;
        return a.startCol - b.startCol;
      });

      const builder = new vscode.SemanticTokensBuilder(this.legend);

      for (const tok of tokens) {
        builder.push(
          new vscode.Range(
            tok.line,
            tok.startCol,
            tok.endLine,
            tok.endCol,
          ),
          tok.tokenType,
          tok.tokenModifiers,
        );
      }

      return builder.build();
    } catch (err) {
      console.error("[TreeSitterProvider] Failed:", err);
      return null;
    }
  }


  releaseDocumentSemanticTokens(_result: vscode.SemanticTokens): void {
    // Nothing to release for tree-sitter tokens
  }
}
