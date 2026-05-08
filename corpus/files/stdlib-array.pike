//! Test Array module functions in Pike.
//! Valid file — all Array operations are valid.

#pike 7.8
#pragma strict_types

// Array.map — apply function to each element
void test_array_map() {
  array(int) nums = ({ 1, 2, 3, 4, 5 });
  array(int) doubled = Array.map(nums, lambda(int x) { return x * 2; });
  array(string) strings = Array.map(nums, lambda(int x) { return (string)x; });
}

// Array.filter — keep elements matching predicate
void test_array_filter() {
  array(int) nums = ({ 1, 2, 3, 4, 5, 6 });
  array(int) evens = Array.filter(nums, lambda(int x) { return x % 2 == 0; });
  array(int) odds = nums - evens;
}

// Array.sort (in-place, returns sorted array)
void test_array_sort() {
  array(int) nums = ({ 5, 3, 1, 4, 2 });
  array(int) sorted = sort(nums); // Pike built-in sort
  array(string) words = ({ "banana", "apple", "cherry" });
  array(string) sorted_words = sort(words);
}

// Array.commonelements and difference
void test_array_set_ops() {
  array(int) a = ({ 1, 2, 3, 4 });
  array(int) b = ({ 3, 4, 5, 6 });
  array(int) common = Array.common_elements(a, b); // ({ 3, 4 })
  array(int) diff = a - b; // ({ 1, 2 })
}

// Array.transpose
void test_array_transpose() {
  array(array(string)) matrix = ({ ({ "a", "b" }), ({ "c", "d" }) });
  array(array(string)) transposed = Array.transpose(matrix);
}

// Array.for_each and enumeration
void test_array_enumerate() {
  array(int) indices = indices(10); // ({ 0, 1, 2, 3, 4, 5, 6, 7, 8, 9 })
  array(string) values = values(([ "a": 1, "b": 2 ])); // ({ 1, 2 })
}

// Array.sum and custom aggregation
void test_array_aggregate() {
  array(int) nums = ({ 1, 2, 3, 4, 5 });
  int total = Array.sum(nums); // 15
  array(int) prefix = Array.reduce(nums, lambda(int a, int b) { return a + b; });
}
