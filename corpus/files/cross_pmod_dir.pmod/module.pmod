// Module definition for cross-pmod-dir
// This file makes cross-pmod-dir/ act as a Pike module when on -M path
#pragma strict_types

constant MODULE_NAME = "cross-pmod-dir";

string capitalize(string s) {
    return String.capitalize(s);
}
