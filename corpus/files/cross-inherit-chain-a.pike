// Corpus: cross-inherit-chain-a.pike
// Exercises: Base of three-file inherit chain
// Priority: P0
// Errors: None expected
// Note: Inherited by cross-inherit-chain-b.pike
#pragma strict_types

class Base {
    protected string label;

    void create(string _label) {
        label = _label;
    }

    string identify() {
        return "Base:" + label;
    }
}

int main() { return 0; }
