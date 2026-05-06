; Keywords
[
  "if" "else" "for" "while" "do" "foreach" "switch" "case" "default"
  "break" "continue" "return"
  "catch" "gauge" "sscanf" "typeof" "lambda"
  "class" "enum" "typedef" "inherit" "import"
  "constant"
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

; Special identifiers
[
  "__attribute__" "__deprecated__"
  "__func__"
  "predef" "bits"
] @keyword

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

; Function calls — postfix_expr is transparent so we can't precisely match
; call vs field access. This matches identifiers followed by argument_list.

; Class declarations
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

; Constants
[
  "this" "this_program"
] @constant.builtin
