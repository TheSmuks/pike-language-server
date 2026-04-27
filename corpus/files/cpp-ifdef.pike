// Corpus: cpp-ifdef.pike
// Exercises: #if, #ifdef, #ifndef, #else, #elif, #endif, conditional compilation
// Priority: P0
// Errors: None expected
#pragma strict_types

// Define a symbol for testing
#define DEBUG_LEVEL 2
#define HAS_FEATURE_X

int main() {
    // Basic #ifdef
#ifdef HAS_FEATURE_X
    string feature = "enabled";
#else
    string feature = "disabled";
#endif

    // #if with expression
#if DEBUG_LEVEL > 1
    int verbosity = 2;
#elif DEBUG_LEVEL > 0
    int verbosity = 1;
#else
    int verbosity = 0;
#endif

    // #ifndef — inverse check
#ifndef UNDEFINED_SYMBOL
    int fallback = 1;
#else
    int fallback = 0;
#endif

    // Nested conditionals
#ifdef HAS_FEATURE_X
    #if DEBUG_LEVEL >= 2
        string detail = "verbose";
    #else
        string detail = "brief";
    #endif
#else
    string detail = "none";
#endif

    return 0;
}
