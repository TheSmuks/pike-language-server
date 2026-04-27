// Exercises: Multiple inheritance, name collision, scope resolution
#pragma strict_types

class A {
  int value() { return 1; }
  string name() { return "A"; }
}

class B {
  int value() { return 2; }
  string label() { return "B"; }
}

class C {
  inherit A;
  inherit B;
  // Name collision on value() — resolve with A::value() and B::value()
  int sum() { return A::value() + B::value(); }
  string description() { return A::name() + "-" + B::label(); }
}

int main() {
  C c = C();
  write("sum = %d\n", c->sum());
  write("desc = %s\n", c->description());
  return 0;
}
