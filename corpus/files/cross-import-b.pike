// Corpus: cross-import-b.pike
// Exercises: Import of .pmod module for cross-file symbol access
// Priority: P0
// Errors: None expected
// Note: Requires cross_import_a.pmod on module path
//   Pike module names use underscores: file is cross_import_a.pmod
//   pike -M. cross-import-b.pike
#pragma strict_types

import cross_import_a;

int main() {
    write("version: %s\n", LIBRARY_VERSION);
    write("name: %s\n", format_name("Jane", "Doe"));
    write("words: %d\n", count_words("hello world foo"));

    Greeter g = Greeter("Hi");
    write("greet: %s\n", g->greet("Alice"));
    return 0;
}
