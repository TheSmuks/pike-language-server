/**
 * Cross-file propagation integration test.
 *
 * Tests that editing an imported/inherited file triggers re-diagnosis
 * of dependents. This test requires real workspace files and a running
 * VSCode extension host.
 *
 * Run: cd tests/integration && npm test
 *
 * This file exists for discoverability. The test will be added to
 * tests/integration/suite/index.ts when run in a VSCode environment.
 *
 * What to test:
 *
 * 1. Inherit-based propagation:
 *    - Create Base.pike with `class Animal { void speak() {} }`
 *    - Create Dependent.pike with `inherit "Base.pike"; Dog d = Dog("Rex");`
 *    - Open Dependent.pike, verify no errors
 *    - Edit Base.pike to rename `speak` to `talk`
 *    - Verify Dependent.pike gets re-diagnosed (Pike compilation picks up the change)
 *
 * 2. Import-based propagation:
 *    - Create SomeModule.pmod with `constant VERSION = "1.0";`
 *    - Create Consumer.pike with `import SomeModule;`
 *    - Open Consumer.pike, verify no errors
 *    - Edit SomeModule.pmod to remove VERSION
 *    - Verify Consumer.pike gets re-diagnosed
 *
 * 3. Three-file chain propagation:
 *    - A.pike defines Base class
 *    - B.pike inherits A, adds Middle class
 *    - C.pike inherits B
 *    - Edit A.pike → verify both B.pike and C.pike get re-diagnosed
 *
 * Prerequisites:
 * - @vscode/test-electron installed and VSCode available
 * - Temp workspace directory with the test files
 * - Extension built and packaged (esbuild)
 *
 * See also:
 * - decisions/0015-import-tracking.md (import dependency semantics)
 * - decisions/0013-verification.md §V3 (cross-file propagation gap)
 * - TRACKING.md Deferred Items (layer-2 integration test)
 */
export {};
