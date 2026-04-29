// Corpus: rename-child.pike
// Exercises: Child class inheriting from rename-base.pike
// Priority: P1
// Errors: None expected
// Note: Requires rename-base.pike in same directory
//   pike rename-child.pike
#pragma strict_types

inherit "rename-base.pike";

class Rectangle {
    inherit BaseShape;

    protected int width;
    protected int height;

    void create(string _color, int w, int h) {
        ::create(_color);
        width = w;
        height = h;
    }

    int area() {
        return width * height;
    }
}
