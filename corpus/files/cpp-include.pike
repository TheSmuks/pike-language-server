// Corpus: cpp-include.pike
// Exercises: #include directive syntax and resolution
// Priority: P1
// Errors: None expected (file doesn't exist — tests include resolution)
#pragma strict_types

// Note: #include requires actual files on include path.
// This tests LSP diagnostic handling when the included file is missing.
#include "nonexistent.pike"

int main() {
    return 0;
}
