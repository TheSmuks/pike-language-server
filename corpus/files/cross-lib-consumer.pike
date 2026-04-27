// Corpus: cross-lib-consumer.pike
// Exercises: Inherits from cross-lib-base.pike, uses its symbols
// Priority: P0
// Errors: None expected
// Note: Requires cross-lib-base.pike to be compilable / on the include path.
//   For testing, add corpus/files/ to the Pike include/module path:
//   pike -I corpus/files/ corpus/files/cross-lib-consumer.pike
#pragma strict_types

// Inherit from the base file (Pike resolves this as a program on include path)
inherit .cross_lib_base.Formatter;

// Alternative: import the module path
// import .cross_lib_base;

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
    string result = bf->format("hello");  // "[hello]"

    // Use utility functions from base file
    int n = parse_int("42");
    string rev = reverse_string("abc");  // "cba"

    return 0;
}
