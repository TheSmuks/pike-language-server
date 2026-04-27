// Exercises: final modifier, override prevention
#pragma strict_types

class Base {
  final void cannot_override() {
    write("Base.cannot_override\n");
  }

  void can_override() {
    write("Base.can_override\n");
  }
}

class Child {
  inherit Base;

  void can_override() {
    write("Child.can_override\n");
  }
}

int main() {
  Child c = Child();
  c->cannot_override();
  c->can_override();
  return 0;
}
