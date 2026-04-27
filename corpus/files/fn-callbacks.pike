// Exercises: Callbacks, function types, function references, lambda
#pragma strict_types

int apply_int(function(string:int) cb, string val) {
  return cb(val);
}

string apply_transform(function(string:string) cb, string val) {
  return cb(val);
}

int str_len(string s) {
  return sizeof(s);
}

string upper(string s) {
  return upper_case(s);
}

void do_callback(function(:void) cb) {
  cb();
}

int main() {
  int len = apply_int(str_len, "hello");
  write("len = %d\n", len);

  string up = apply_transform(upper, "world");
  write("upper = %s\n", up);

  // Lambda as callback
  int custom = apply_int(lambda(string s) { return sizeof(s) * 2; }, "abc");
  write("custom = %d\n", custom);

  // Function reference via `function
  function(string:int) ref = str_len;
  write("ref = %d\n", ref("test"));

  // Void callback
  do_callback(lambda() { write("callback fired\n"); });

  return 0;
}
