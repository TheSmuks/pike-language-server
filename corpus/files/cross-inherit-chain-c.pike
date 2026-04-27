// Corpus: cross-inherit-chain-c.pike
// Exercises: End of three-file inherit chain
// Priority: P0
// Errors: None expected
// Note: Requires cross-inherit-chain-b.pike (and transitively chain-a) in same directory
//   pike cross-inherit-chain-c.pike
#pragma strict_types

inherit "cross-inherit-chain-b.pike";

class End {
    inherit Middle;

    string identify() {
        return "End:" + ::identify();
    }
}

int main() {
    End e = End("final");
    write("identify: %s\n", e->identify());
    return 0;
}
