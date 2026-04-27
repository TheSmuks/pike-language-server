// Corpus: err-type-return.pike
// Exercises: Functions returning wrong type under strict_types
// Priority: P0
// Expected errors:
//   Function returning string from int, int from string, array(string) from array(int), value from void
#pragma strict_types

int get_number() {
    // ERROR: returning string from int function
    return "not a number";  // ERROR: Bad return type. Expected: int. Got: string.
}

string get_text() {
    // ERROR: returning int from string function
    return 42;  // ERROR: Bad return type. Expected: string. Got: int.
}

array(int) get_ints() {
    // ERROR: returning array(string) from array(int) function
    return ({"one", "two"});  // ERROR: Bad return type. Expected: array(int). Got: array(string).
}

void do_nothing() {
    // ERROR: returning value from void function
    return 1;  // ERROR: Bad return type. Expected: void. Got: int.
}

int main() {
    return 0;
}
