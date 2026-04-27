// Corpus: cross-inherit-simple-a.pike
// Exercises: Base file providing class and function for cross-file inherit
// Priority: P0
// Errors: None expected
// Note: Inherited by cross-inherit-simple-b.pike
#pragma strict_types

constant SPECIES = "Animal";

class Animal {
    protected string name;
    protected string sound;

    void create(string _name, string _sound) {
        name = _name;
        sound = _sound;
    }

    string speak() {
        return name + " says " + sound;
    }

    string get_name() {
        return name;
    }
}

string describe(Animal a) {
    return SPECIES + ": " + a->get_name();
}

int main() { return 0; }
