/**
 * Pike reserved words — cannot be used as identifiers.
 *
 * Source: Pike lexer src/lexer.h keyword switch + Pike manual ch2-7.
 *
 * Shared because two callers need it for opposite reasons: rename rejects a
 * new name that is reserved, and the reference collector drops keywords that
 * reach it spelled as identifiers — which is how a `#define` body lexes them,
 * since a macro body is a token sequence with no keyword positions in it.
 */
export const PIKE_KEYWORDS: ReadonlySet<string> = new Set([
  // Type keywords
  "array", "auto", "float", "function", "int", "mapping", "mixed",
  "multiset", "object", "program", "string", "void",

  // Declaration keywords
  "class", "constant", "enum", "extern", "import", "inherit", "lambda",
  "predef", "typedef", "typeof",

  // Modifier keywords
  "final", "inline", "local", "nomask", "optional", "private",
  "protected", "public", "static", "variant",

  // Control flow keywords
  "break", "case", "catch", "continue", "default", "do", "else",
  "for", "foreach", "goto", "if", "return", "sscanf", "switch", "while",

  // Special expression keywords
  "gauge", "global",

  // Double-underscore modifier keywords (Pike 9.0+)
  "__async__", "__attribute__", "__deprecated__", "__experimental__",
  "__generator__", "__weak__", "__unused__", "__unknown__",
]);
