; tree-sitter highlights for Pike

; Preprocessor directives
(prepreprocessor_directive) @preproc

; Comments
(line_comment) @comment
(block_comment) @comment
(doc_comment) @comment.documentation

; Strings
(string) @string
(char_literal) @string

; Type keywords
(primitive_type) @type
(type_identifier) @type

; Declaration keywords
"class" @keyword
"inherit" @keyword.import
"import" @keyword.import
"typedef" @keyword
"enum" @keyword
"constant" @keyword

; Control flow
"if" @keyword
"else" @keyword.control
"for" @keyword.control
"while" @keyword.control
"do" @keyword.control
"foreach" @keyword.control
"switch" @keyword.control
"case" @keyword.control
"default" @keyword.control
"break" @keyword.control
"continue" @keyword.control
"return" @keyword.control

; Modifiers
"static" @storage
"private" @storage
"protected" @storage
"public" @storage
"local" @storage
"final" @storage
"inline" @storage
"extern" @storage
"variant" @storage
"optional" @storage
"nomask" @storage

; Other keywords
"lambda" @keyword
"typeof" @keyword
"catch" @keyword

; Identifiers
(identifier) @variable

; Function/method calls
(call_expression
  function: (identifier) @function)

; Method definition
(method_definition
  name: (identifier) @function.method)

; Function definition
(function_definition
  name: (identifier) @function)

; Numbers
(integer_literal) @number
(float_literal) @number

; Operators
(binary_expression
  operator: _ @operator)
(unary_expression
  operator: _ @operator)

; Punctuation
"{" @punctuation.bracket
"}" @punctuation.bracket
"(" @punctuation.bracket
")" @punctuation.bracket
"[" @punctuation.bracket
"]" @punctuation.bracket
"," @punctuation.delimiter
";" @punctuation.delimiter
":" @punctuation.delimiter
"." @punctuation.dot
"::" @operator
"->" @operator
