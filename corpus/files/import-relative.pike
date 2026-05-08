//! Test relative import paths in Pike.
//! Valid file — relative imports use "." notation.

#pike 7.8
#pragma strict_types

// Relative imports use "." to refer to the current directory's modules
// For example, in a subdirectory, ".module" refers to module.pike in same dir

// Standard absolute imports (for reference)
import Stdio; // standard stdlib import

// Relative imports are typically used in Pike like:
// import .; // import current directory's module.pike
// import .sibling; // import sibling.pike in current directory
// import ..parent; // import parent module from parent directory
// import .foo.bar; // import bar from foo/ directory

// Example: importing a relative module if it exists in the corpus
// This would work in a proper module path setup:
// import .cross_lib_module;

// Using imported symbols from stdlib
void test_stdio_usage() {
  Stdio.File f = Stdio.File();
  // f->open("test.txt", "r");
}

// Module paths can be relative
// import .; // import local module
// import ..; // import parent module
