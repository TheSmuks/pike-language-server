// Corpus: basic-generics.pike
// Exercises: Parameterized types — array(T), mapping(K:V), function(T:R), multiset(T)
// Priority: P0
// Errors: None expected
#pragma strict_types

// Generic array types
int sum(array(int) nums) {
    int total = 0;
    foreach (nums; int i; int val) {
        total += val;
    }
    return total;
}

// Generic mapping types
int lookup_int(mapping(string:int) m, string key) {
    return m[key];
}

// Generic multiset types
int has_tag(multiset(string) tags, string tag) {
    return tags[tag];
}

// Function type variables
function(int:int) doubler = lambda (int x) { return x * 2; };

// function type as parameter
int apply_fn(function(int:int) f, int val) {
    return f(val);
}

// Compound generic: mapping from string to function
mapping(string:function(int:int)) ops = ([
    "double": lambda (int x) { return x * 2; },
    "negate": lambda (int x) { return -x; },
]);

int main() {
    array(int) numbers = ({1, 2, 3, 4, 5});
    int total = sum(numbers);

    mapping(string:int) scores = (["alice": 95, "bob": 87]);
    int alice_score = lookup_int(scores, "alice");

    multiset(string) active = (<"ready", "running">);
    int is_ready = has_tag(active, "ready");

    int result = apply_fn(doubler, 5);
    int negated = ops["negate"](3);

    return 0;
}
