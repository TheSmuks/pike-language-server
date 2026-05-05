//! Test Mapping and m_delete functions in Pike.
//! Valid file — all Mapping operations are valid.

#pike 7.8
#pragma strict_types

// Basic mapping operations
void test_mapping_basics() {
  mapping(string:int) m = ([
    "one": 1,
    "two": 2,
    "three": 3
  ]);
  
  int val = m["two"];             // 2
  m["four"] = 4;                  // add entry
  m_delete(m, "three");           // remove entry
}

// m_delete — removes a key from mapping
void test_m_delete() {
  mapping(string:int) m = ([ "a": 1, "b": 2, "c": 3 ]);
  int removed = m_delete(m, "b"); // removes "b", returns old value (2)
  // m is now ([ "a": 1, "c": 3 ])
}

// Mapping iteration
void test_mapping_iteration() {
  mapping(string:int) m = ([ "x": 10, "y": 20, "z": 30 ]);
  foreach (m; string key; int val) {
    // process key and val
  }
  array(string) keys = indices(m);  // ({ "x", "y", "z" })
  array(int) values = values(m);    // ({ 10, 20, 30 })
}

// Mapping lookups with default
void test_mapping_tryget() {
  mapping(string:int) m = ([ "a": 1, "b": 2 ]);
  int val = m["a"];                    // 1
  int missing = m["z"] || 0;            // default pattern
}

// Mapping stats
void test_mapping_stats() {
  mapping(string:int) m = ([ "x": 1, "y": 2 ]);
  int size = sizeof(m);                 // 2
  int has_x = has_index(m, "x");        // 1 (true)
  int has_z = has_index(m, "z");        // 0 (false)
}

// Typed mapping
void test_typed_mapping() {
  mapping(string:string) string_map = ([ "key": "value" ]);
  mapping(int:object) obj_map = ([ 1: this, 2: this ]);
}

// Mapping copy and merge
void test_mapping_copy() {
  mapping(string:int) original = ([ "a": 1, "b": 2 ]);
  mapping(string:int) copy = +original; // shallow copy
  copy["c"] = 3;
  // original unchanged
}