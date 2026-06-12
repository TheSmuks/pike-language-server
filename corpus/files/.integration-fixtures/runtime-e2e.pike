#pragma strict_types
class Foo {
  int value;
  int method(int amount) { return value + amount; }
}
int add(int left, int right) { return left + right; }
int main() {
  Foo foo = Foo();
  int total = add(1, 2);
  object obj = foo;
  obj->missingMember();
  return total + foo.method(3);
}
