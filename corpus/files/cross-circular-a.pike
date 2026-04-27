// Corpus: cross-circular-a.pike
// Exercises: Circular cross-file references (A references B)
// Priority: P1
// Errors: None expected
// Note: Used with cross-circular-b.pike to test circular resolution
#pragma strict_types

int func_a(int x) {
    if (x <= 0) return 0;
    return x * 2;
}

string label_a() { return "I am A"; }

int main() { return 0; }
