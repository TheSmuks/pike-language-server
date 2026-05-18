# PUnit Test Framework Integration

## Overview

The pike-language-server project uses [PUnit](https://github.com/TheSmuks/punit-tests) (v1.3.0) as its Pike testing framework. PUnit is a JUnit-inspired testing framework written in Pike, providing assertions, lifecycle hooks, fixtures, and multiple output formats.

## Directory Structure

```
tests/pike/
  run_tests.pike           # Test runner entry point
  PUnitSmokeTests.pike     # Smoke tests verifying framework integration
  CompilationHandlerTests.pike  # Tests for DiagnosticHandler
  DiagnosticsTests.pike    # Tests for normalize_diagnostics
  VersionTests.pike        # Tests for version utilities
  TestBootstrap.pmod       # Shared test helpers (fixtures, assertions)

modules/
  PUnit.pmod/              # PUnit framework (vendored dependency)

harness/
  Common.pike              # Shared Pike utilities (DiagnosticHandler, etc.)
```

## Running Tests

### Run all Pike tests

```bash
bun run test:pike
```

Or directly with Pike:

```bash
pike -M modules -M harness -M tests/pike tests/pike/run_tests.pike tests/pike
```

### Run a single test file

```bash
pike -M modules -M harness -M tests/pike tests/pike/run_tests.pike tests/pike/PUnitSmokeTests.pike
```

### Verbose output

```bash
pike -M modules -M harness -M tests/pike tests/pike/run_tests.pike -v tests/pike
```

### Other output formats

```bash
# TAP output
pike -M modules -M harness -M tests/pike tests/pike/run_tests.pike --tap tests/pike

# JUnit XML
pike -M modules -M harness -M tests/pike tests/pike/run_tests.pike --junit=report.xml tests/pike

# List tests without running
pike -M modules -M harness -M tests/pike tests/pike/run_tests.pike --list=verbose tests/pike
```

### Filtering

```bash
# By tag
pike -M modules -M harness -M tests/pike tests/pike/run_tests.pike --tag=math tests/pike

# By method name pattern
pike -M modules -M harness -M tests/pike tests/pike/run_tests.pike --filter=test_add* tests/pike
```

## Writing Tests

### Basic test file

```pike
import PUnit;
inherit PUnit.TestCase;

void test_my_feature() {
  assert_equal(42, my_function());
}
```

### Available assertions

| Category      | Functions                                                    |
|---------------|--------------------------------------------------------------|
| Equality      | `assert_equal`, `assert_not_equal`, `assert_same`, `assert_not_same` |
| Boolean       | `assert_true`, `assert_false`                                |
| Comparison    | `assert_gt`, `assert_lt`, `assert_gte`, `assert_lte`        |
| Null          | `assert_null`, `assert_not_null`, `assert_undefined`        |
| Membership    | `assert_contains`, `assert_match`                            |
| Exception     | `assert_throws`, `assert_throws_fn`, `assert_no_throw`, `assert_throws_message` |
| Collection    | `assert_each`, `assert_contains_only`, `assert_has_size`     |
| Misc          | `assert_fail`, `assert_type`, `assert_approx_equal`          |

### Lifecycle hooks

```pike
inherit PUnit.TestCase;

void setup() {
  // Runs before each test method
}

void teardown() {
  // Runs after each test method
}

void setup_class() {
  // Runs once before all tests in this class
}

void teardown_class() {
  // Runs once after all tests in this class
}
```

### Using the test bootstrap helper

```pike
import PUnit;
import TestBootstrap;

inherit PUnit.TestCase;

void test_something() {
  object handler = create_diagnostic_handler();
  handler->compile_error("test.pike", 10, "Bad type.");
  assert_has_diagnostic(
    normalize_diagnostics(handler->errors, handler->warnings),
    "error", 10, "type_mismatch"
  );
}
```

## Dependencies

PUnit is declared in `pike.json` and managed by `pmp` (Pike Module Package manager):

```bash
# Install dependencies (if pmp is available)
pmp install
```

If `pmp` is not available, manually vendor PUnit:

```bash
mkdir -p modules
git clone https://github.com/TheSmuks/punit-tests.git /tmp/punit-tests
cd /tmp/punit-tests && git checkout v1.3.0
cp -r PUnit.pmod /path/to/pike-language-server/modules/
```

Note: The `modules/` directory is gitignored -- it is populated by `pmp install` or manual vendoring.
