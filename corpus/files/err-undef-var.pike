// Corpus: err-undef-var.pike
// Exercises: References to undefined variables and functions
// Priority: P0
// Expected errors:
//   Line 11: Undefined identifier: nonexistent_var
//   Line 14: Undefined identifier: undefined_function
#pragma strict_types

int main() {
    // ERROR: using a variable that was never declared
    int x = nonexistent_var;  // ERROR: Undefined identifier: nonexistent_var.

    // ERROR: calling a function that was never defined
    int y = undefined_function();  // ERROR: Undefined identifier: undefined_function.

    // Correct usage for contrast
    int z = 10;

    return 0;
}
