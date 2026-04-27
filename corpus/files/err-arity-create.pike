// Corpus: err-arity-create.pike
// Exercises: Wrong arity in create() and ::create() calls
// Priority: P0
// Expected errors:
//   Too many/too few arguments in create() instantiation and parent call
#pragma strict_types

class Foo {
    void create(int a) {
    }
}

class Bar {
    void create(int a, int b, int c) {
    }
}

class Parent {
    int val;
    void create(int v) {
        val = v;
    }
}

class Child {
    inherit Parent;

    void create(int x) {
        // ERROR: Parent::create expects 1 arg, given 2
        ::create(x, x);  // ERROR: Too many arguments to create.
    }
}

int main() {
    // ERROR: Foo.create takes 1 arg, given 2
    Foo f = Foo(1, 2);  // ERROR: Too many arguments to create.

    // ERROR: Bar.create takes 3 args, given 1
    Bar b = Bar(1);  // ERROR: Too few arguments to create.

    // Correct usage for contrast
    Foo f2 = Foo(1);

    return 0;
}
