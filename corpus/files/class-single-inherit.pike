// Corpus: class-single-inherit.pike
// Exercises: Single inheritance, :: operator, parent method calls, super dispatch
// Priority: P0
// Errors: None expected
#pragma strict_types

class Animal {
    protected string name;
    protected string sound;

    void create(string _name, string _sound) {
        name = _name;
        sound = _sound;
    }

    string describe() {
        return name + " says " + sound;
    }

    string get_name() {
        return name;
    }
}

class Dog {
    inherit Animal;
    protected string breed;

    void create(string _name, string _breed) {
        ::create(_name, "woof");
        breed = _breed;
    }

    // Override parent method
    string describe() {
        // Call parent implementation via ::
        return ::describe() + " (breed: " + breed + ")";
    }

    string get_breed() {
        return breed;
    }
}

class GuideDog {
    inherit Dog;
    protected string handler;

    void create(string _name, string _breed, string _handler) {
        ::create(_name, _breed);
        handler = _handler;
    }

    // Override again, calling Dog::
    string describe() {
        return ::describe() + " handler: " + handler;
    }
}

int main() {
    Dog d = Dog("Rex", "German Shepherd");
    string desc = d->describe();
    string name = d->get_name();

    GuideDog gd = GuideDog("Buddy", "Labrador", "Alice");
    string gd_desc = gd->describe();

    return 0;
}
