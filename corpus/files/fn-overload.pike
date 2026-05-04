// Corpus: fn-overload.pike
// Exercises: Typed function parameters, polymorphic dispatch patterns
// Priority: P1
// Errors: None expected
#pragma strict_types

int doubleInt(int x) { return x * 2; }
string doubleString(string s) { return s + s; }
array(mixed) doubleArray(array(mixed) arr) { return arr + arr; }

mixed dispatch(mixed value) {
    if (intp(value)) return doubleInt(value);
    if (stringp(value)) return doubleString(value);
    if (arrayp(value)) return doubleArray(value);
    return value;
}

int main() {
    write("Int: %d\n", dispatch(21));
    write("String: %s\n", dispatch("ab"));
    write("Array: %d\n", sizeof(dispatch(({1, 2}))));
    return 0;
}
