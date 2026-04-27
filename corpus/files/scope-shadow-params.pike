// Corpus: scope-shadow-params.pike
// Exercises: Parameter shadowing, block scope, lambda capture
// Priority: P1
// Errors: None expected
#pragma strict_types

int x = 100;

int add(int a, int b) {
    return a + b;
}

int main() {
    int x = 1;  // shadows file-scope x

    if (1) {
        int x = 2;  // shadows function-scope x
        write("inner x = %d\n", x);  // 2
    }

    write("outer x = %d\n", x);  // 1

    // Nested function captures enclosing scope
    function(:int) get_x = lambda() {
        return x;  // captures function-scope x (1)
    };
    write("lambda x = %d\n", get_x());  // 1

    return 0;
}
