// Corpus: err-undef-member.pike
// Exercises: Access to undefined object members
// Priority: P0
// Expected errors:
//   Access to members that are not declared in the class
#pragma strict_types

class Foo {
    int x;

    void create(int _x) {
        x = _x;
    }
}

int main() {
    Foo o = Foo(42);

    // ERROR: accessing member that does not exist in Foo
    int v = o->nonexistent;  // ERROR: Undefined identifier: nonexistent.

    // ERROR: accessing another undeclared member
    o->y = 10;  // ERROR: Undefined identifier: y.

    return 0;
}
