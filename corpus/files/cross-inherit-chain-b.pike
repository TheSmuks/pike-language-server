// Corpus: cross-inherit-chain-b.pike
// Exercises: Middle of three-file inherit chain
// Priority: P0
// Errors: None expected
// Note: Requires cross-inherit-chain-a.pike in same directory
//   pike cross-inherit-chain-b.pike
#pragma strict_types

inherit "cross-inherit-chain-a.pike";

class Middle {
    inherit Base;

    string identify() {
        return "Middle:" + ::identify();
    }
}

int main() {
    Middle m = Middle("test");
    write("identify: %s\n", m->identify());
    return 0;
}
