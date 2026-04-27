// Corpus: cross-inherit-simple-b.pike
// Exercises: Cross-file inherit of class from another .pike file
// Priority: P0
// Errors: None expected
// Note: Requires cross-inherit-simple-a.pike in same directory
//   pike cross-inherit-simple-b.pike
#pragma strict_types

// Inherit the entire file; all its top-level symbols become available
inherit "cross-inherit-simple-a.pike";

class Dog {
    inherit Animal;

    void create(string name, string|void _sound) {
        ::create(name, _sound || "woof");
    }

    string fetch(string item) {
        return get_name() + " fetches " + item;
    }
}

int main() {
    Dog d = Dog("Rex");
    write("speak: %s\n", d->speak());
    write("fetch: %s\n", d->fetch("stick"));
    write("describe: %s\n", describe(d));
    write("species: %s\n", SPECIES);
    return 0;
}
