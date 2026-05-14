// Test file for unreachable code lint detection
//
// Expected lint diagnostics:
// - P3003: 'write("never")' is unreachable (after return)
// - P3003: 'x = 99' is unreachable (after break)
// - P3003: 'write("after continue")' is unreachable (after continue)
// - NO warning for code after if-return (the if may not execute)

int test_return() {
    return 42;
    write("never");  // unreachable
}

int test_break() {
    for (int i = 0; i < 10; i++) {
        if (i == 5) {
            break;
            int x = 99;  // unreachable
        }
    }
    return 0;
}

void test_continue() {
    for (int i = 0; i < 10; i++) {
        if (i == 3) {
            continue;
            write("after continue");  // unreachable
        }
        write("ok");
    }
}

// Guard clause — NOT unreachable (the return is conditional)
string test_guard(int x) {
    if (x < 0) {
        return "negative";
    }
    return "non-negative";
}
