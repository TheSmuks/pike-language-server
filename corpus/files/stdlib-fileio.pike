// Corpus: stdlib-fileio.pike
// Exercises: Stdio.File, Stdio.read_file, Stdio.write_file, Stdio.append_file
// Priority: P0
// Errors: None expected (file ops are guarded)
#pragma strict_types

int main() {
    // Write a temp file
    string tmp = "/tmp/corpus_stdlib_test.txt";
    Stdio.write_file(tmp, "Hello from corpus\n");

    // Read it back
    string content = Stdio.read_file(tmp);
    if (content == 0) {
        werror("Failed to read %s\n", tmp);
        return 1;
    }

    // Append to it
    Stdio.append_file(tmp, "Appended line\n");

    // Stdio.File — open for reading
    object f = Stdio.File(tmp, "r");
    if (f) {
        mixed line = f->gets();
        f->close();
    }

    // Stdio.FILE — buffered I/O
    object bf = Stdio.FILE();
    bf->open(tmp, "r");
    if (bf) {
        mixed whole = bf->read();
        bf->close();
    }

    // Stdio.exist — check file existence
    int exists = Stdio.exist(tmp);

    // Clean up
    rm(tmp);

    return 0;
}
