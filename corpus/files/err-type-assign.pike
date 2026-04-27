// Corpus: err-type-assign.pike
// Exercises: Type errors in assignments under strict_types
// Priority: P0
// Expected errors:
//   Line 12: Bad type in assignment — Expected: int, Got: string
//   Line 18: Bad type in assignment — Expected: array(int), Got: array(string)
#pragma strict_types

int main() {
    int x = 42;
    // ERROR: assigning string to int variable
    x = "not an int";  // ERROR: Bad type in assignment. Expected: int. Got: string.

    string s = "hello";

    array(int) nums = ({1, 2, 3});
    // ERROR: assigning wrong generic type
    nums = ({"a", "b"});  // ERROR: Bad type in assignment. Expected: array(int). Got: array(string).

    // Correct usage for contrast
    int y = 100;
    y = 200;

    return 0;
}
