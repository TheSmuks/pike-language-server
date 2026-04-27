// Corpus: fn-types.pike
// Exercises: Function type declarations, function pointers, lambda, anonymous functions
// Priority: P0
// Errors: None expected
#pragma strict_types

// Named function with typed parameters and return
int add(int a, int b) {
    return a + b;
}

// Function type variable
function(int, int : int) binop = add;

// Lambda assigned to typed variable
function(string : int) length_fn = lambda (string s) {
    return sizeof(s);
};

// Anonymous function via lambda
function(int : void) side_effect = lambda(int x) {
    // do something with x
};

// Function taking a function argument (higher-order)
array(int) map_ints(array(int) arr, function(int : int) f) {
    array(int) result = ({});
    foreach (arr; int i; int val) {
        result += ({f(val)});
    }
    return result;
}

// Returning a function (closure factory)
function(int : int) make_adder(int offset) {
    return lambda (int x) { return x + offset; };
}

int main() {
    int sum = binop(3, 4);

    int len = length_fn("hello");

    // Use closure factory
    function(int : int) add5 = make_adder(5);
    int result = add5(10); // 15

    // Higher-order with lambda
    array(int) doubled = map_ints(({1, 2, 3}), lambda (int x) { return x * 2; });

    // Function pointer via `functionof` not needed — direct reference works
    function(int, int : int) sub = lambda (int a, int b) { return a - b; };

    return 0;
}
