//! Test type mismatch on member access (should produce Pike error).
//! Error file — accessing wrong type members.

#pike 7.8
#pragma strict_types

class Dog {
  string name;
  void create(string n) { name = n; }
  string bark() { return "woof"; }
}

class Cat {
  string name;
  void create(string n) { name = n; }
  string meow() { return "meow"; }
}

void test_type_mismatch() {
  Dog d = Dog("Rex");
  // ERROR: Dog has no method 'meow' — accessing wrong type member
  string result = d->meow();
  // ERROR: Cat has no method 'bark'
  Cat c = Cat("Whiskers");
  string result2 = c->bark();
}

void test_method_on_primitive() {
  int x = 42;
  // ERROR: int has no method 'foo'
  string result = x->foo();
}

void test_member_on_string() {
  string s = "hello";
  // ERROR: string has no member 'nonexistent'
  int len = s->nonexistent;
}

void test_wrong_argument_type() {
  class Foo {
    void method(int x) { }
  }
  Foo f = Foo();
  // ERROR: wrong type for argument 1 to Foo->method()
  f->method("not an int");
}
