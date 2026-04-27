// Corpus: cross-pmod-user.pike
// Exercises: Using symbols from a .pmod directory module
// Priority: P0
// Errors: None expected
// Note: Requires cross_pmod_dir.pmod/ directory on module path
//   Pike directory modules use .pmod suffix on the directory name
//   pike -M. cross-pmod-user.pike
#pragma strict_types

// Import the directory module
import cross_pmod_dir;

int main() {
    write("module: %s\n", MODULE_NAME);
    write("capitalize: %s\n", capitalize("hello world"));
    return 0;
}
