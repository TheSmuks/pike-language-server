// Corpus: rename-crossfile-cat.pike
// Exercises: Cross-file type filtering for rename
// Cat class also has bark() method — Dog.bark rename should NOT affect these
class Cat {
    void bark() {
        write("meow\n");
    }
}
