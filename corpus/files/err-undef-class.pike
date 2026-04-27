// Corpus: err-undef-class.pike
// Exercises: Inheriting from and instantiating undefined classes
// Priority: P0
// Expected errors:
//   Inherit of nonexistent class, instantiation of nonexistent class
#pragma strict_types

// ERROR: inheriting from a class that does not exist
inherit NonExistentClass;  // ERROR: Undefined identifier: NonExistentClass.

int main() {
    // ERROR: instantiating a class that does not exist
    NonExistentClass o = NonExistentClass();  // ERROR: Undefined identifier: NonExistentClass.

    return 0;
}
