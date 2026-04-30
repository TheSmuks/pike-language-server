// Corpus: inference-failure.pike
// Exercises: Inference failure — mixed returns, unknown types, unresolvable access
// Priority: P1
// Errors: Expected (Pike should report some warnings/errors under strict_types)
#pragma strict_types

// Function returning mixed — no type info for inference
mixed get_unknown() {
    if (random(2))
        return "string";
    else
        return 42;
}

// Function with no explicit return type
get_untyped() {
    return "hello";
}

class Known {
    string value;

    void create(string v) {
        value = v;
    }

    string get_value() {
        return value;
    }
}

int test_mixed_return_access() {
    mixed x = get_unknown();
    // x is mixed from function return — no member resolution possible
    return 0;
}

int test_untyped_return() {
    mixed y = get_untyped();
    // y is mixed — function has no return type annotation
    return 0;
}

int test_unresolved_member() {
    Known k = Known("test");
    string v = k->get_value();
    // This should work — Known has get_value
    return 0;
}

// Variable with no initializer — no inference possible
int test_no_initializer() {
    mixed z;
    z = 42;
    return 0;
}
