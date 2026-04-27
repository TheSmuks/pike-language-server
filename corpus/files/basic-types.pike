// Corpus: basic-types.pike
// Exercises: All Pike primitive types — int, float, string, void, mixed, zero
// Priority: P0
// Errors: None expected
#pragma strict_types

int main() {
    // int — integer type
    int count = 42;
    int negative = -1;
    int hex = 0xFF;
    int octal = 077;
    int binary = 0b1010;

    // float — floating point
    float pi = 3.14159;
    float sci = 1.0e6;

    // string — string type
    string name = "hello";
    string empty = "";
    string multi = "line1\nline2";

    // void — only valid as return type, tested in separate function below

    // mixed — accepts any type
    mixed anything = 42;
    anything = "now a string";
    anything = ({1, 2, 3});

    // zero — the type of the value 0 / UNDEFINED
    // In Pike, zero-typed variables are declared as mixed or specific types
    mixed z = 0;  // zero value

    // bool-like — Pike uses int(0..1) for booleans
    int(0..1) flag = 1;

    return 0;
}

// void return type
void do_nothing() {
    // no return
}

// program type — program() returns a program reference
program p = Stdio.File;

// object type
object obj = Stdio.FILE();
