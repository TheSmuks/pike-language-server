// Corpus: class-forward-refs.pike
// Exercises: Forward references in class scope (constants, methods)
// Priority: P1
// Errors: None expected
#pragma strict_types

class Calculator {
    // Method calling another method declared later
    int compute(int x) {
        return multiply(x, get_factor());
    }

    int multiply(int a, int b) {
        return a * b;
    }

    int get_factor() {
        return 3;
    }
}

int main() {
    object calc = Calculator();
    write("compute(5) = %d\n", calc->compute(5));  // 15
    return 0;
}
