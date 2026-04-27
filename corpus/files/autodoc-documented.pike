// Corpus: autodoc-documented.pike
// Exercises: AutoDoc extraction from //! doc comments
// Priority: P0
// Expected: AutoDoc XML should contain documentation for documented_class and documented_method

#pragma strict_types

//! A class that demonstrates AutoDoc documentation.
//! This class has multiple doc lines.
class DocumentedClass {
  //! The value stored in this class.
  int value;

  //! Create a new DocumentedClass with the given value.
  //! @param v
  //!   The initial value.
  void create(int v) {
    value = v;
  }

  //! Get the current value.
  //! @returns
  //!   The stored integer value.
  int get_value() {
    return value;
  }
}

//! A documented standalone function.
//! @param x
//!   The input value.
//! @returns
//!   The doubled input.
int documented_function(int x) {
  return x * 2;
}
