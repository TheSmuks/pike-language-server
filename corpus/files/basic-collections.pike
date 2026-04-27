// Corpus: basic-collections.pike
// Exercises: Array, mapping, multiset literals with strict_types
// Priority: P0
// Errors: None expected
#pragma strict_types

int main() {
    // Array literals
    array(int) ints = ({1, 2, 3, 4, 5});
    array(string) strs = ({"alpha", "beta", "gamma"});
    array(mixed) mixed_arr = ({1, "two", 3.0});

    // Empty arrays
    array(int) empty_ints = ({});
    array zero_arr = 0; // zero-typed array

    // Mapping literals
    mapping(string:int) word_counts = (["hello": 1, "world": 2]);
    mapping(int:string) lookup = ([1: "one", 2: "two"]);
    mapping empty_map = ([]);

    // Multiset literals
    multiset(string) tags = (<"important", "urgent">);
    multiset(int) ids = (<1, 2, 3>);
    multiset empty_ms = (<>);

    // Nested collections
    array(array(int)) matrix = ({({1, 2}), ({3, 4})});
    mapping(string:array(int)) data = (["nums": ({1, 2, 3})]);

    // Collection operations
    int sz = sizeof(ints);
    array(int) appended = ints + ({6});
    mapping(string:int) merged = word_counts + (["new": 3]);

    return 0;
}
