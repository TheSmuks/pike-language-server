// Exercises: Nested module resolution, Calendar, ADT, Crypto, String
#pragma strict_types

int main() {
  // Calendar.ISO
  Calendar.Second now = Calendar.ISO.Second();
  write("now = %s\n", now->format_ext_time());

  // ADT.Stack
  ADT.Stack stk = ADT.Stack();
  stk->push(10);
  stk->push(20);
  write("stack top = %O\n", stk->top());

  // String.Buffer
  String.Buffer sbuf = String.Buffer();
  sbuf->add("hello");
  sbuf->add(" ");
  sbuf->add("buffer");
  write("sbuf = %s\n", (string)sbuf);

  return 0;
}
