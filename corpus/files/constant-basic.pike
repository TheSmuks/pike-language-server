// Corpus: constant-basic.pike
// Exercises: constant declarations
// Priority: P1
// Errors: None expected
#pragma strict_types

constant MAX_SIZE = 1024;
constant NAME = "Pike LSP";
constant EMPTY_ARRAY = ({});
constant VERSION = 1.0;

int main() {
    write("Max: %d\n", MAX_SIZE);
    write("Name: %s\n", NAME);
    write("Array size: %d\n", sizeof(EMPTY_ARRAY));
    write("Version: %f\n", VERSION);
    return 0;
}
