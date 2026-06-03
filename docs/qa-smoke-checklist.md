# Pike LSP QA Smoke Checklist

Use this checklist when the automated VS Code integration lab cannot answer the
question, especially for visual color/theme behavior. Run it in a real VS Code
window with the current VSIX or extension development host installed.

## Setup

1. Build and install the extension:
   ```bash
   PATH="/home/smuks/.nvm/versions/node/v22.22.2/bin:/home/smuks/.bun/bin:$PATH" bash scripts/build-vsix.sh
   PATH="/home/smuks/.nvm/versions/node/v22.22.2/bin:/home/smuks/.bun/bin:$PATH" bash scripts/install-extension.sh
   ```
2. Open `corpus/files/semantic-color-smoke.pike` or create a scratch `.pike` file
   with the snippets below.
3. Set `pike.languageServer.path` to the real Pike binary when validating oracle
   behavior. Set it to a nonexistent path only for the degradation check.
4. Use at least one common dark theme and one common light theme because semantic
   token colors are theme-defined.

## Visual checks automation cannot prove

### Type names and member names

Snippet:
```pike
class Foo { int value; int method() { return value; } }
int main() {
  Foo foo = Foo();
  object obj = foo;
  return obj->member + foo.method();
}
```

Expected:
- `Foo` is colored as a type/class at declaration and use sites.
- `foo` is colored as a variable.
- `method` is colored as a member/method.
- `obj->member` still colors `member` distinctly even if type resolution cannot
  prove the member exists.

### Aggregate delimiters remain ordinary punctuation

Snippet:
```pike
int main() {
  array(int) values = ({ 1, 2, 3 });
  mapping(string:int) counts = ([ "one": 1 ]);
  multiset(string) names = (< "Ada" >);
  return values[0];
}
```

Expected:
- `({`, `})`, `([`, `])`, `(<`, and `>)` render as ordinary punctuation, not as a
  custom aggregate-delimiter color.
- `values[0]` and nested calls such as `foo(values[0])` do not mis-color closing
  `])` or `})` as aggregate delimiters.

### TextMate baseline vs semantic-token overlay

Expected:
- On file open, the coarse TextMate colors appear quickly.
- When semantic tokens arrive, colors may refine but should not flicker between
  contradictory classifications.
- Temporarily break `pike.languageServer.path`: tree-sitter-backed symbols and
  semantic colors should remain; Pike diagnostics should disappear rather than
  crashing or leaving stale errors.

### Edge cases

Check these snippets visually and with hover/go-to-definition where appropriate:

```pike
int `+(int left, int right) { return left + right; }
int main() {
  array(int) arr = ({ 1, 2, 3 });
  int café = arr[0];
  return `+(café, arr[1]);
}
```

Expected:
- Operator-name identifier `` `+ `` is scoped as a function identifier.
- Unicode identifier `café` highlights as one identifier; hover and navigation do
  not land one character early or late.
- Saving the same file with CRLF line endings preserves correct hover/diagnostic
  ranges.
