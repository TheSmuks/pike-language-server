// Corpus: rename-main.pike
// Exercises: Main file using classes from rename-base and rename-child
// Priority: P1
// Errors: None expected
// Note: Requires rename-base.pike and rename-child.pike in same directory
//   pike rename-main.pike
#pragma strict_types

inherit "rename-base.pike";
inherit "rename-child.pike";

int main() {
    BaseShape s = BaseShape("red");
    write("shape: %s\n", s->describe());
    write("area: %d\n", s->area());
    write("default: %s\n", DEFAULT_COLOR);

    Rectangle r = Rectangle("blue", 3, 4);
    write("rect area: %d\n", r->area());
    write("rect: %s\n", r->describe());
    return 0;
}
