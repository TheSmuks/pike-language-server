// Corpus: err-type-generic.pike
// Exercises: Generic type violations under strict_types
// Priority: P0
// Expected errors:
//   Incorrect generic type arguments in array, mapping, multiset, function
#pragma strict_types

int main() {
    // ERROR: array(int) assigned array(string)
    array(int) a = ({"string"});  // ERROR: Bad type in assignment. Expected: array(int). Got: array(string).

    // ERROR: mapping(string:int) assigned mapping(int:int)
    mapping(string:int) m = ([1:2]);  // ERROR: Bad type in assignment. Expected: mapping(string:int). Got: mapping(int:int).

    // ERROR: multiset(int) assigned multiset(string)
    multiset(int) ms = (<"str">);  // ERROR: Bad type in assignment. Expected: multiset(int). Got: multiset(string).

    // ERROR: function(int:void) assigned function(string:void)
    function(int:void) f = lambda(string s) { };  // ERROR: Bad type in assignment. Expected: function(int:void).

    return 0;
}
