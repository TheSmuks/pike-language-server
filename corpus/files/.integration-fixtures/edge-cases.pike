#pragma strict_types
int `+(int left, int right) { return left + right; }
int main() {
  array(int) arr = ({ 1, 2, 3 });
  mapping(string:int) counts = ([ "one": 1 ]);
  multiset(string) names = (< "Ada" >);
  int café = arr[0];
  return `+(café, arr[1]);
}
