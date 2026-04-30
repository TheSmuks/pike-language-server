// Corpus: inference-chained.pike
// Exercises: Chained inference — a()->b()->c() pattern, cascading member access
// Priority: P1
// Errors: None expected
#pragma strict_types

class Wheel {
    string brand;
    int diameter;

    void create(string _brand, int _diameter) {
        brand = _brand;
        diameter = _diameter;
    }

    string info() {
        return brand + " " + diameter + "in";
    }
}

class Vehicle {
    string make;
    Wheel wheel;

    void create(string _make, Wheel _wheel) {
        make = _make;
        wheel = _wheel;
    }

    Wheel get_wheel() {
        return wheel;
    }

    string get_make() {
        return make;
    }
}

class Factory {
    string name;

    void create(string _name) {
        name = _name;
    }

    Vehicle build() {
        return Vehicle("Toyota", Wheel("Michelin", 17));
    }
}

// Chained access: factory->build()->get_wheel()->info()
int test_chained() {
    Factory f = Factory("Plant1");
    Vehicle v = f->build();
    Wheel w = v->get_wheel();
    string info = w->info();
    return 0;
}

// Single-expression chained access
int test_inline_chain() {
    Factory f = Factory("Plant2");
    string make = f->build()->get_make();
    return 0;
}

// Deep chained access through mixed intermediate
int test_mixed_chain() {
    mixed v = Factory("Plant3")->build();
    // v has declaredType mixed, assignedType Factory
    // accessing v->get_make() should resolve through assignedType chain
    return 0;
}
