// Test file for constructor and method signature help
//
// Classes with create() methods, method calls via arrow access,
// and local functions for baseline signature tests.

class Dog {
  string name;
  int age;

  void create(string name, int age) {
    this.name = name;
    this.age = age;
  }

  void bark(string msg, int volume) {
    write(msg + "!");
  }

  int getAge() {
    return age;
  }
}

class Cat {
  string color;

  void create(string color) {
    this.color = color;
  }

  void meow() {
    write("meow");
  }
}

void greet(string greeting, int times) {
  for (int i = 0; i < times; i++) {
    write(greeting);
  }
}

int main() {
  // Constructor calls — signature help should show create() params
  Dog d = Dog("Rex", 5);
  Cat c = Cat("black");

  // Method calls — signature help should show method params
  d->bark("hello", 3);
  d->getAge();
  c->meow();

  // Regular function call
  greet("hi", 2);

  return 0;
}
