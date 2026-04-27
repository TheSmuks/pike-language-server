// Corpus: cross-stdlib.pike
// Exercises: Standard library references (Stdio.File, Stdio.write_file)
// Priority: P0
// Errors: None expected
// Flags: None required
#pragma strict_types

int main() {
    // Use Stdio.File object for file I/O
    Stdio.File f = Stdio.File();
    string tmppath = "/tmp/corpus-stdlib-test-" + (string)getpid();
    Stdio.write_file(tmppath, "hello stdlib\n");

    // Read back with Stdio.File
    if (f->open(tmppath, "r")) {
        string data = f->read(100);
        f->close();
        write("Read: %O\n", data);
    }

    // Read with Stdio.read_file
    string content = Stdio.read_file(tmppath);
    write("Content: %O\n", content);

    // Clean up
    rm(tmppath);

    // Use Array functions
    array(int) nums = ({ 3, 1, 4, 1, 5 });
    array(int) sorted = Array.sort(nums);
    write("Sorted: %{%d %}\n", sorted);

    return 0;
}
