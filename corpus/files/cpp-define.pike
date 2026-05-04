// Corpus: cpp-define.pike
// Exercises: #define, #undef, #ifdef, #if preprocessor directives
// Priority: P1
// Errors: None expected
#pragma strict_types

#define MAX_BUFFER 4096
#define VERSION "1.0"
#define IS_DEBUG

#ifdef IS_DEBUG
#define LOG(x) write("DEBUG: %s\n", x)
#else
#define LOG(x)
#endif

#undef IS_DEBUG

int main() {
    write("Buffer size: %d\n", MAX_BUFFER);
    write("Version: %s\n", VERSION);
#ifdef IS_DEBUG
    write("Debug mode\n");
#else
    write("Release mode\n");
#endif
    LOG("Application started");
    return 0;
}
