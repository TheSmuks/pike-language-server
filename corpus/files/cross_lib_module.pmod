// Exercises: .pmod module structure, module-level declarations
#pragma strict_types

constant MODULE_VERSION = "1.0";

string greet(string name) {
  return "Hello, " + name + "!";
}

int factorial(int n) {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}

class Calculator {
  int add(int a, int b) { return a + b; }
  int multiply(int a, int b) { return a * b; }
  float divide(int a, int b) {
    if (b == 0) return 0.0;
    return (float)a / (float)b;
  }
}
