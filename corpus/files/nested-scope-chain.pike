// Corpus: nested-scope-chain.pike
// Exercises: Deeply nested scope chain resolution (3+ levels)
// Priority: P1
// Errors: None expected
// Note: Tests that hover/definition on variables in outer scopes
//   resolves correctly through the scope chain.
#pragma strict_types

void deep() {
    string level0 = "L0";

    for (int i = 0; i < 1; i++) {
        string level1 = level0 + "L1";

        while (true) {
            string level2 = level0 + level1;

            if (true) {
                string level3 = level0 + level1 + level2;
                write("result: %s\n", level3);
                break;
            }

            break;
        }
    }
}

int main() {
    deep();
    return 0;
}
