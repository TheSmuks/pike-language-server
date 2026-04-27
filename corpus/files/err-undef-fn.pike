// Corpus: err-undef-fn.pike
// Exercises: Calls to undefined functions
// Priority: P0
// Expected errors:
//   Lines calling undefined_function, completely_missing, not_a_real_function
#pragma strict_types

int main() {
    // ERROR: calling a completely undefined function
    undefined_function();  // ERROR: Undefined identifier: undefined_function.

    // ERROR: calling undefined function with arguments
    completely_missing("hello", 42);  // ERROR: Undefined identifier: completely_missing.

    // ERROR: assigning result of undefined function call
    int x = not_a_real_function();  // ERROR: Undefined identifier: not_a_real_function.

    // ERROR: calling undefined function in expression
    string s = sprintf("result: %d", ghost_function());  // ERROR: Undefined identifier: ghost_function.

    return 0;
}
