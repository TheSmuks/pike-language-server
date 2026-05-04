// Corpus: import-pmod.pike
// Exercises: .pmod directory module imports
// Priority: P1
// Errors: None expected
// Note: Requires corpus/files on module path
//   pike -M corpus/files import-pmod.pike
#pragma strict_types

// Import the directory module
import my_module;

int main() {
    write("Module name: %s\n", MODULE_NAME);
    write("Capitalize: %s\n", capitalize("hello"));
    return 0;
}
