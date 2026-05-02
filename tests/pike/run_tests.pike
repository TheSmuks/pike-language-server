#!/usr/bin/env pike
// run_tests.pike — PUnit test runner for Pike Language Server
//
// Usage: pike -M modules run_tests.pike [test_dir]
//   test_dir  Optional directory containing .pike test files (default: ./)

import PUnit;
import PUnit.TestRunner;
import PUnit.VerboseReporter;
import PUnit.TestCase;

int main(int argc, array(string) argv) {
  // Add module paths for test discovery
  // When TestRunner compiles test files via compile_string, they need access to:
  // - harness/Common.pike (for get_pike_version, normalize_diagnostics, DiagnosticHandler)
  // - modules/PUnit.pmod (for assertions, TestCase, etc.)
  string project_root = getcwd();
  // Handle running from tests/pike/ directory
  if (has_suffix(project_root, "/tests/pike")) {
    project_root = project_root[..sizeof(project_root)-sizeof("/tests/pike")+1];
  } else if (has_suffix(project_root, "/tests")) {
    project_root = project_root[..sizeof(project_root)-sizeof("/tests")+1];
  }
  
  // Add paths to the Pike master so compiled test files can find modules
  master()->add_module_path(project_root + "/harness");
  master()->add_module_path(project_root + "/modules");
  
  array(string) test_dirs = argc > 1 ? ({ argv[1] }) : ({ "." });
  
  // Create test runner with verbose output
  object runner = TestRunner((["verbose": 1]));
  
  // Run tests
  int result = runner->run(test_dirs);
  
  // Exit with appropriate code
  return result;
}