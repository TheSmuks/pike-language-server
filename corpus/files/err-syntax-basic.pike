// Corpus: err-syntax-basic.pike
// Exercises: Basic syntax errors that Pike rejects at parse time
// Priority: P0
// Expected errors:
//   Pike will report a parse/syntax error on the malformed lines below.
//   This file is intentionally broken.

#pragma strict_types

int main() {
    // Missing semicolon
    int x = 42  // ERROR: Expected ';'

    // Unmatched brace (extra closing)
    }}

    // Missing closing paren in expression
    string s = "hello" + (  // ERROR: Unexpected end of file / unmatched '('

    return 0;
}
