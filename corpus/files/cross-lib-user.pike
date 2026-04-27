// Exercises: Importing .pmod modules, using module symbols via inherit
#pragma strict_types

// The module is in the same directory; add cwd to module path with -M.
// Invocation: pike -Mcorpus/files/ corpus/files/cross-lib-user.pike
inherit cross_lib_module;

int main() {
  write("version = %s\n", MODULE_VERSION);
  write("greet = %s\n", greet("corpus"));
  write("factorial(6) = %d\n", factorial(6));

  Calculator calc = Calculator();
  write("add = %d\n", calc->add(3, 4));
  write("multiply = %d\n", calc->multiply(5, 6));
  write("divide = %f\n", calc->divide(7, 2));

  return 0;
}
