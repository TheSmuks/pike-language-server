// Corpus: cross-lib-consumer.pike
// Exercises: Inherits from cross-lib-base.pike, uses its symbols
// Priority: P0
// Errors: None expected
// Note: Requires cross-lib-base.pike to be compilable / on the include path.
// For testing, add corpus/files/ to the Pike include/module path:
// pike -I corpus/files/ corpus/files/cross-lib-consumer.pike
#pragma strict_types

// Inherit the base file as a program. The dot-relative form `.cross_lib_base`
// cannot be used here: Pike maps that to a file literally named
// `cross_lib_base.pike`, and this file is `cross-lib-base.pike` — hyphens are
// legal in a filename but not in the dotted module path. The string form
// inherits the file directly, which is what the sibling fixtures do too
// (see rename-main.pike).
inherit "cross-lib-base.pike";

class BracketFormatter {
  inherit Formatter;

  void create() {
    // Chain to parent constructor
    ::create("[", "]");
  }

  string format(string data) {
    return ::format(data);
  }
}

int main() {
  BracketFormatter bf = BracketFormatter();
  string result = bf->format("hello"); // "[hello]"

  // Use utility functions from base file
  int n = parse_int("42");
  string rev = reverse_string("abc"); // "cba"

  return 0;
}
