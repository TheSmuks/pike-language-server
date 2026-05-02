//! VersionTests.pike — Unit tests for get_pike_version function

import PUnit;
import PUnit.TestRunner;

// Import Common module
import Common;

inherit PUnit.TestCase;

// Access Common module object
object get_common() { return Common(); }

void test_get_pike_version_returns_non_empty_string() {
  string version = get_common()->get_pike_version();
  assert_true(sizeof(version) > 0);
}

void test_get_pike_version_contains_dot() {
  string version = get_common()->get_pike_version();
  assert_true(has_value(version, "."));
}

void test_get_pike_version_matches_expected_format() {
  string version = get_common()->get_pike_version();
  // Format should be "major.minor" or "major.minor.patch"
  int dots = 0;
  for (int i = 0; i < sizeof(version); i++) {
    if (version[i] == '.') dots++;
  }
  assert_true(dots >= 1); // At least one dot for "X.Y" or "X.Y.Z" format
}

void test_get_pike_version_starts_with_digit() {
  string version = get_common()->get_pike_version();
  assert_true(version[0] >= '0' && version[0] <= '9');
}

void test_get_pike_version_contains_release_number() {
  string version = get_common()->get_pike_version();
  // Release part should be numeric
  string release = (version/ ".")[-1];
  int is_numeric = 1;
  for (int i = 0; i < sizeof(release); i++) {
    if (release[i] < '0' || release[i] > '9') {
      is_numeric = 0;
      break;
    }
  }
  assert_true(is_numeric);
}