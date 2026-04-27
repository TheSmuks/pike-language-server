// Corpus: class-inherit-rename.pike
// Exercises: Inherit with rename, alias::member access
// Priority: P1
// Errors: None expected
#pragma strict_types

class Base {
    string label = "base";

    string describe() {
        return "Base: " + label;
    }

    int get_value() {
        return 42;
    }
}

class Derived {
    inherit Base : parent;

    string label = "derived";

    string who() {
        // Access through alias
        return parent::describe();
    }

    int value() {
        return parent::get_value();
    }
}

int main() {
    object d = Derived();
    write("who: %s\n", d->who());
    write("value: %d\n", d->value());
    return 0;
}
