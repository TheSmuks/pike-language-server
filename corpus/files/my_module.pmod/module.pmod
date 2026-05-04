// my_module.pmod/module.pmod
// Part of: import-pmod.pike corpus
#pragma strict_types

constant MODULE_NAME = "MyModule";

string capitalize(string s) {
    if (sizeof(s) == 0) return s;
    return upper_case(s[0..0]) + s[1..];
}

class Math {
    int add(int a, int b) { return a + b; }
}
