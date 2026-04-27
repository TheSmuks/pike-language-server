// Exercises: this, this_program, this_object(), fluent pattern
#pragma strict_types

class Builder {
  string buf = "";

  Builder add(string s) {
    buf += s;
    return this;
  }

  string build() {
    return buf;
  }

  object self_ref() {
    return this_object();
  }

  string own_type() {
    return sprintf("%O", this_program);
  }
}

int main() {
  Builder b = Builder();
  string result = b->add("hello")->add(" ")->add("world")->build();
  write("result = %s\n", result);
  write("self_ref same? %d\n", b == b->self_ref());
  write("type = %s\n", b->own_type());
  return 0;
}
