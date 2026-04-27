// Corpus: err-arity-many.pike
// Exercises: Too many arguments passed to functions
// Priority: P0
// Expected errors:
//   Calls with excess arguments to user-defined and built-in functions
#pragma strict_types

void greet(string name) {
    write("Hello, " + name + "!\n");
}

int add(int a, int b) {
    return a + b;
}

class Foo {
    void create(int x) {
    }
}

int main() {
    // ERROR: greet takes 1 arg, given 2
    greet("hello", "world");  // ERROR: Too many arguments to greet.

    // ERROR: add takes 2 args, given 3
    add(1, 2, 3);  // ERROR: Too many arguments to add.

    // ERROR: Foo.create takes 1 arg, instantiated with 2
    Foo f = Foo(1, 2);  // ERROR: Too many arguments to create.

    return 0;
}
