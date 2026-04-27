// Corpus: cross-inherit-rename-a.pike
// Exercises: Base file with class, constant, and function for renamed inherit
// Priority: P0
// Errors: None expected
// Note: Inherited by cross-inherit-rename-b.pike
#pragma strict_types

constant TYPE = "combustion";

class Engine {
    protected int horsepower;

    void create(int hp) {
        horsepower = hp;
    }

    string describe() {
        return sprintf("Engine(%d hp)", horsepower);
    }
}

float efficiency(float load) {
    return load * 0.85;
}

int main() { return 0; }
