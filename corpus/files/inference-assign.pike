// Corpus: inference-assign.pike
// Exercises: Assignment inference — variable assigned from typed function, accessing members
// Priority: P1
// Errors: None expected
#pragma strict_types

class Engine {
    int horsepower;
    string fuel;

    void create(int hp, string f) {
        horsepower = hp;
        fuel = f;
    }

    int get_hp() {
        return horsepower;
    }
}

class Car {
    string model;
    Engine engine;

    void create(string _model, Engine _engine) {
        model = _model;
        engine = _engine;
    }

    Engine get_engine() {
        return engine;
    }

    string info() {
        return model + " (" + engine->horsepower + " hp)";
    }
}

// Direct assignment from constructor
int test_constructor_assign() {
    Engine e = Engine(300, "gasoline");
    int hp = e->get_hp();
    return hp;
}

// Assignment from function returning typed object
int test_function_assign() {
    Car car = Car("Model S", Engine(400, "electric"));
    string info = car->info();
    Engine eng = car->get_engine();
    return eng->horsepower;
}

// mixed assignment from constructor — inference should extract type name
int test_mixed_constructor() {
    mixed eng = Engine(200, "diesel");
    // eng has declaredType mixed but assignedType Engine
    return 0;
}
