// Corpus: import-stdlib.pike
// Exercises: import Stdio; using imported symbols from standard library
// Priority: P0
// Errors: None expected
#pragma strict_types

import Stdio;

int main() {
    // Stdio.File — basic file handle
    object f = File();

    // Stdio.write_file — returns int (bytes written)
    int bytes = write_file("/dev/null", "test");

    // Using Stdio.mkdirhier via import
    // (not executing, just ensuring symbol resolves)
    mkdirhier("/tmp/corpus-test/");

    return 0;
}
