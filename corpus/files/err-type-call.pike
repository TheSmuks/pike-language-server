// Corpus: err-type-call.pike
// Exercises: Wrong argument types in function calls under strict_types
// Priority: P0
// Expected errors:
//   Line 23: Bad argument 1 to double_it — Expected: int, Got: string
//   Line 26: Bad argument 1 to greet — Expected: string, Got: int
#pragma strict_types

string greet(string name) {
    return "Hello, " + name;
}

int double_it(int n) {
    return n * 2;
}

int main() {
    // Correct calls
    string msg = greet("World");
    int val = double_it(21);

    // ERROR: passing string where int is expected
    int bad = double_it("not a number");  // ERROR: Bad argument 1 to double_it.

    // ERROR: passing int where string is expected
    string bad2 = greet(42);  // ERROR: Bad argument 1 to greet.

    return 0;
}
