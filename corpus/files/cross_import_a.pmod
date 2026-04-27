// Corpus: cross-import-a.pmod
// Exercises: .pmod module file for import testing
// Priority: P0
// Errors: None expected
// Note: Used by cross-import-b.pike with -M . flag
//       .pmod files as modules don't need main() but Pike still
//       requires it when run directly. We provide one for compilation checks.
#pragma strict_types

constant LIBRARY_VERSION = "2.0";

string format_name(string first, string last) {
    return first + " " + last;
}

int count_words(string text) {
    return sizeof(text / " ") - 1 + 1;
}

class Greeter {
    string greeting;
    void create(string msg) { greeting = msg; }
    string greet(string name) { return greeting + ", " + name + "!"; }
}

int main() { return 0; }
