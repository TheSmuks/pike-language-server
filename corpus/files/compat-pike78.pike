// Corpus: compat-pike78.pike
// Exercises: #pike version directive for compatibility module resolution
// Priority: P1
// Errors: None expected
// Note: Uses #pike 7.8 which changes module search paths
#pragma strict_types
#pike 7.8

int main() {
    // With #pike 7.8, module resolution checks lib/7.8/modules/ first
    // Stdio should still work (it has a 7.8 compat version)
    write("Hello from #pike 7.8 mode\n");
    return 0;
}
