// Corpus: inference-return.pike
// Exercises: Return type inference — function returning typed object, caller accessing members
// Priority: P1
// Errors: None expected
#pragma strict_types

class Shape {
    string kind;
    int sides;

    void create(string _kind, int _sides) {
        kind = _kind;
        sides = _sides;
    }

    string describe() {
        return kind + " with " + sides + " sides";
    }
}

// Function with explicit Shape return type
Shape make_triangle() {
    return Shape("triangle", 3);
}

// Function with explicit return type, caller accesses members
int test_explicit_return() {
    Shape s = make_triangle();
    string desc = s->describe();
    return s->sides;
}

// Function with mixed return type — inference should still work at call site
mixed make_shape_mixed() {
    return Shape("square", 4);
}

int test_mixed_return() {
    mixed m = make_shape_mixed();
    // m has declaredType mixed — assignment-based inference should extract Shape
    return 0;
}
