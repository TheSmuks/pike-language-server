// Corpus: rename-crossfile-main.pike
// Exercises: Cross-file rename type filtering
// This file uses both Dog and Cat from other files
inherit "rename-crossfile-dog.pike";
inherit "rename-crossfile-cat.pike";

void test() {
    Dog d = Dog();
    Cat c = Cat();
    
    // This should be renamed when we rename Dog.bark()
    d->bark();
    
    // This should NOT be renamed when we rename Dog.bark()
    // because c's type is Cat, not Dog
    c->bark();
}
