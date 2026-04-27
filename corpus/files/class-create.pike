// Corpus: class-create.pike
// Exercises: Constructor create(), ::create() chaining, argument forwarding
// Priority: P0
// Errors: None expected
#pragma strict_types

class Base {
    protected int id;

    void create(int _id) {
        id = _id;
    }

    int get_id() {
        return id;
    }
}

class Middle {
    inherit Base;
    protected string label;

    void create(int _id, string _label) {
        // Chain to parent constructor
        ::create(_id);
        label = _label;
    }

    string get_label() {
        return label;
    }
}

class Leaf {
    inherit Middle;
    protected float weight;

    void create(int _id, string _label, float _weight) {
        // Chain through full hierarchy
        ::create(_id, _label);
        weight = _weight;
    }

    string info() {
        return sprintf("id=%d label=%s weight=%.2f",
                       get_id(), get_label(), weight);
    }
}

// Class with no explicit create (uses default)
class Simple {
    string name = "default";
}

int main() {
    Leaf leaf = Leaf(1, "node", 3.14);
    string info = leaf->info();

    Simple s = Simple();
    string n = s->name;

    return 0;
}
