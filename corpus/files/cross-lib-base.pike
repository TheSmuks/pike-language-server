// Corpus: cross-lib-base.pike
// Exercises: Base class / library module for cross-file reference testing
// Priority: P0
// Errors: None expected
// Note: This file is inherited by cross-lib-consumer.pike
#pragma strict_types

class Formatter {
    protected string prefix;
    protected string suffix;

    void create(string _prefix, string _suffix) {
        prefix = _prefix;
        suffix = _suffix;
    }

    string format(string data) {
        return prefix + data + suffix;
    }

    string get_prefix() { return prefix; }
    string get_suffix() { return suffix; }
}

// Utility functions that the consumer will call
int parse_int(string s) {
    return (int)s;
}

string reverse_string(string s) {
    return reverse(s);
}

constant VERSION = "1.0.0";

int main() { return 0; }
