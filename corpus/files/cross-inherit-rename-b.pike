// Corpus: cross-inherit-rename-b.pike
// Exercises: Cross-file inherit with rename (alias)
// Priority: P0
// Errors: None expected
// Note: Requires cross-inherit-rename-a.pike in same directory
//   pike cross-inherit-rename-b.pike
#pragma strict_types

inherit "cross-inherit-rename-a.pike" : motor;

class Car {
    int speed;

    void create(int hp, int top_speed) {
        speed = top_speed;
        // Access inherited Engine via the file inherit
    }

    string describe() {
        return sprintf("Car(speed=%d)", speed);
    }
}

int main() {
    Engine e = Engine(200);
    write("Engine: %s\n", e->describe());
    write("Type: %s\n", TYPE);
    write("Efficiency: %.2f\n", efficiency(100.0));

    Car c = Car(200, 180);
    write("Car: %s\n", c->describe());
    return 0;
}
