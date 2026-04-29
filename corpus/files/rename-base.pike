// Corpus: rename-base.pike
// Exercises: Base class for multi-file rename test
// Priority: P1
// Errors: None expected
// Note: Inherited by rename-child.pike, used by rename-main.pike
#pragma strict_types

class BaseShape {
    protected string color;

    void create(string _color) {
        color = _color;
    }

    string describe() {
        return "Shape(" + color + ")";
    }

    int area() {
        return 0;
    }
}

constant DEFAULT_COLOR = "black";
