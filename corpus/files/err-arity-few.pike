// Corpus: err-arity-few.pike
// Exercises: Too few arguments to function call
// Priority: P0
// Expected errors:
//   Line 19: Too few arguments to greet (got 1)
//   Line 22: Too few arguments to add (got 0)
#pragma strict_types

string greet(string name, string greeting) {
    return greeting + ", " + name + "!";
}

int add(int a, int b) {
    return a + b;
}

int main() {
    // ERROR: missing second argument
    string s = greet("Alice");  // ERROR: Too few arguments to greet.

    // ERROR: missing both arguments to add (passing zero args)
    int n = add();  // ERROR: Too few arguments to add.

    // Correct call
    string ok = greet("Alice", "Hi");

    return 0;
}
