// Corpus: cross-circular-b.pike
// Exercises: Circular cross-file references (B references A)
// Priority: P1
// Errors: None expected
// Note: Used with cross-circular-a.pike to test circular resolution
#pragma strict_types

int func_b(string s) {
    if (sizeof(s) == 0) return 0;
    return sizeof(s);
}

string label_b() { return "I am B"; }

int main() { return 0; }
