// Corpus: scope-for-catch.pike
// Exercises: For-loop init scoping, catch block scoping
// Priority: P1
// Errors: None expected
#pragma strict_types

int main() {
    // For-loop init variable scoped to for body
    for (int i = 0; i < 3; i++) {
        write("i = %d\n", i);
    }
    // i is NOT in scope here

    // Catch block - variables inside are catch-scoped
    mixed err = catch {
        int x = 10;
        write("x in catch: %d\n", x);
    };
    write("err = %O\n", err);
    // x is NOT in scope here

    return 0;
}
