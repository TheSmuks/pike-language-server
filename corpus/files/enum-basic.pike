// Corpus: enum-basic.pike
// Exercises: enum declaration, enum values, typed enums
// Priority: P0
// Errors: None expected
#pragma strict_types

// Basic enum
enum Color {
    RED,
    GREEN,
    BLUE,
}

// Enum with explicit values
enum Status {
    STATUS_UNKNOWN = 0,
    STATUS_PENDING = 1,
    STATUS_ACTIVE = 2,
    STATUS_CLOSED = 3,
}

// Typed enum (enum values are ints in Pike)
enum TokenKind {
    TOK_IDENT,
    TOK_NUMBER,
    TOK_STRING,
    TOK_EOF,
}

string color_name(Color c) {
    switch (c) {
        case RED:   return "red";
        case GREEN: return "green";
        case BLUE:  return "blue";
        default:    return "unknown";
    }
}

int main() {
    Color c = RED;
    string name = color_name(c);

    Status s = STATUS_ACTIVE;
    int sval = (int)s;

    // Enum in conditional
    if (s == STATUS_ACTIVE) {
        // active
    }

    // Array of enum values
    array(Color) colors = ({RED, GREEN, BLUE});

    return 0;
}
