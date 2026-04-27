// Corpus: fn-lambda.pike
// Exercises: Lambda expressions, anonymous functions, closures capturing variables
// Priority: P0
// Errors: None expected
#pragma strict_types

int main() {
    // Basic lambda
    function(int : int) square = lambda (int x) {
        return x * x;
    };

    // Lambda capturing a variable (closure)
    int offset = 10;
    function(int : int) add_offset = lambda (int x) {
        return x + offset;  // captures 'offset' from enclosing scope
    };

    // Anonymous function (via lambda)
    function(string : void) logger = lambda(string msg) {
        werror("[LOG] %s\n", msg);
    };

    // Lambda in map context
    array(int) nums = ({1, 2, 3, 4, 5});
    array(int) squares = map(nums, square);

    // Inline lambda with multiple args
    function(string, string : int) compare_len = lambda (string a, string b) {
        return sizeof(a) - sizeof(b);
    };

    // Lambda returning a lambda (closure factory)
    function(string : function(:string)) make_greeter = lambda (string greeting) {
        return lambda () {
            return greeting + "!";
        };
    };

    function(:string) hi = make_greeter("Hi there");
    string msg = hi();

    // Closure mutating captured variable
    int counter = 0;
    function(:int) increment = lambda () {
        counter++;
        return counter;
    };
    int c1 = increment();  // 1
    int c2 = increment();  // 2

    return 0;
}
