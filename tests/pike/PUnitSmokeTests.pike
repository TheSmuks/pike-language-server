//! PUnitSmokeTests.pike — Smoke test verifying PUnit framework integration
//!
//! Goal: Confirm that PUnit is correctly installed, importable, and can
//! execute assertions across all major categories (equality, boolean,
//! comparison, null, membership, exception, collection, misc).
//!
//! Methodology: Each test exercises one assertion category from PUnit,
//! proving the module path resolution, assertion macros, and test runner
//! discovery all work end-to-end.

import PUnit;

inherit PUnit.TestCase;

// --- Equality assertions ---

void test_assert_equal_passes() {
  assert_equal(42, 42);
}

void test_assert_not_equal_passes() {
  assert_not_equal(1, 2);
}

// --- Boolean assertions ---

void test_assert_true_passes() {
  assert_true(1);
}

void test_assert_false_passes() {
  assert_false(0);
}

// --- Comparison assertions ---

void test_assert_gt_passes() {
  assert_gt(10, 5);
}

void test_assert_lt_passes() {
  assert_lt(3, 7);
}

// --- Null assertions ---

void test_assert_null_passes() {
  assert_null(0);
}

void test_assert_not_null_passes() {
  assert_not_null("hello");
}

// --- Membership assertions ---

void test_assert_contains_passes() {
  assert_contains("world", "hello world");
}

// --- Collection assertions ---

void test_assert_has_size_passes() {
  assert_has_size(({10, 20, 30}), 3);
}

// --- Lifecycle hooks (verify setup/teardown integration) ---

protected int setup_counter = 0;
protected int teardown_counter = 0;

void setup() {
  setup_counter += 1;
}

void teardown() {
  teardown_counter += 1;
}

void test_setup_was_called() {
  // setup() runs before each test, so counter should be >= 1 at this point
  assert_true(setup_counter >= 1);
}

// --- Exception assertions ---

void test_assert_throws_passes() {
  assert_throws(UNDEFINED, lambda() { error("expected error\n"); });
}

// --- Framework version ---

void test_punit_version_is_set() {
  // PUnit.Version module should exist and have a version string
  assert_not_null(PUnit.Version.version);
  assert_true(sizeof(PUnit.Version.version) > 0);
}
