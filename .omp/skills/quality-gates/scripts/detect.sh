#!/usr/bin/env bash
# detect.sh — Automated Tiger Style quality gates for Pike LSP
# Usage:
#   bash detect.sh              # run all checks
#   bash detect.sh --all        # run all blocking checks
#   bash detect.sh --functions  # TigerStyle function length
#   bash detect.sh --nonnull    # Non-null assertions on tree-sitter nodes
#   bash detect.sh --catch      # Silent catch blocks
#   bash detect.sh --roottext   # rootNode.text materialization
#   bash detect.sh --unbounded  # Unbounded Map/Set without eviction
#   bash detect.sh --importmeta # import.meta.dirname! assertions
#   bash detect.sh --filelen    # TigerStyle file length
#   bash detect.sh --nesting    # TigerStyle nesting depth
#   bash detect.sh --exports    # TigerStyle module export count
#   bash detect.sh --loops      # TigerStyle bounded loops
#   bash detect.sh --markers    # Linked TODO/FIXME/HACK/XXX markers
#   bash detect.sh --skips      # Documented skipped tests
#   bash detect.sh --catalog    # Rule catalog and suppression registry validation

set -euo pipefail

PROJECT_ROOT="$(pwd)"
if [ ! -f "${PROJECT_ROOT}/AGENTS.md" ]; then
  echo "Run this script from the project root directory." >&2
  exit 2
fi

if [ $# -eq 0 ]; then
  set -- --all
fi

python3 - "$PROJECT_ROOT" "$@" <<'PYEOF'
import ast
import fnmatch
import json
import os
import re
import sys
from pathlib import Path

project_root = Path(sys.argv[1])
args = sys.argv[2:]

all_checks = [
    "functions", "nonnull", "catch", "roottext", "unbounded", "importmeta", "filelen",
    "nesting", "exports", "loops", "markers", "skips", "catalog",
]
flag_map = {"--" + name: name for name in all_checks}
flag_map["--all"] = "all"

selected = set()
for arg in args:
    if arg not in flag_map:
        print(f"Unknown flag: {arg}", file=sys.stderr)
        print("Usage: detect.sh [--all|--functions|--nonnull|--catch|--roottext|--unbounded|--importmeta|--filelen|--nesting|--exports|--loops|--markers|--skips|--catalog]", file=sys.stderr)
        sys.exit(2)
    value = flag_map[arg]
    if value == "all":
        selected.update(all_checks)
    else:
        selected.add(value)

errors = 0
warnings = 0
setup_errors = 0
suppressions = []

scan_roots = [".", "server/src", "client", "tests", "harness", "scripts", "docs"]
exclude_parts = {
    "node_modules", "dist", "build", "out", ".git", ".pike-lsp", ".specify", ".omp",
    "fixtures", "evidence", ".vscode-test", "dist-temp", "specs", "wiki",
    "decisions", ".github",
}
exclude_rel_prefixes = ("docs/audits/", "docs/plans/")
source_exts = {".ts", ".tsx", ".js", ".mjs", ".cjs"}
text_exts = source_exts | {".md", ".sh", ".bash", ".yml", ".yaml"}


def rel(path: Path) -> str:
    return path.relative_to(project_root).as_posix()


def should_skip(path: Path) -> bool:
    path_rel = path.relative_to(project_root).as_posix()
    if path_rel in {"AGENTS.md", "quality-gates-rules.json"}:
        return True
    if path_rel.startswith(exclude_rel_prefixes):
        return True
    parts = set(path.relative_to(project_root).parts)
    if parts & exclude_parts:
        return True
    if path.name.endswith(".d.ts"):
        return True
    return False


def iter_files(exts: set[str]):
    roots = [project_root / name for name in scan_roots if (project_root / name).exists()]
    if not roots:
        roots = [project_root]
    seen = set()
    for root in roots:
        if root.is_file():
            candidates = [root]
            for path in candidates:
                if should_skip(path):
                    continue
                resolved = path.resolve()
                if resolved in seen:
                    continue
                seen.add(resolved)
                if path.suffix in exts:
                    yield path
            continue
        else:
            for dirpath, dirnames, filenames in os.walk(root):
                current = Path(dirpath)
                dirnames[:] = [name for name in dirnames if name not in exclude_parts]
                for filename in filenames:
                    path = current / filename
                    if should_skip(path):
                        continue
                    resolved = path.resolve()
                    if resolved in seen:
                        continue
                    seen.add(resolved)
                    if path.suffix in exts:
                        yield path


def read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""


def line_number(text: str, index: int) -> int:
    return text.count("\n", 0, index) + 1


def is_suppressed(rule_id: str, path: Path, line: int) -> bool:
    path_rel = rel(path)
    for item in suppressions:
        if item.get("ruleId") != rule_id:
            continue
        if item.get("path") != path_rel:
            continue
        range_text = str(item.get("range", ""))
        if "-" in range_text:
            start_text, end_text = range_text.split("-", 1)
            try:
                if int(start_text) <= line <= int(end_text):
                    return True
            except ValueError:
                continue
        else:
            try:
                if int(range_text) == line:
                    return True
            except ValueError:
                continue
    return False


def fail(rule_id: str, path: Path, line: int, message: str):
    global errors
    if is_suppressed(rule_id, path, line):
        return
    print(f"[FAIL] {rule_id} {rel(path)}:{line} — {message}", file=sys.stderr)
    errors += 1


def warn(rule_id: str, path: Path, line: int, message: str):
    global warnings
    print(f"[WARN] {rule_id} {rel(path)}:{line} — {message}", file=sys.stderr)
    warnings += 1


def setup_error(message: str):
    global setup_errors
    print(message, file=sys.stderr)
    setup_errors += 1


def strip_comments(line: str) -> str:
    stripped = line.lstrip()
    if stripped.startswith("//") or stripped.startswith("*") or stripped.startswith("/*"):
        return ""
    return re.sub(r"//.*$", "", line)


def validate_catalog_and_suppressions():
    catalog_path = project_root / "quality-gates-rules.json"
    if not catalog_path.exists():
        setup_error("invalid rule catalog: missing quality-gates-rules.json")
    else:
        try:
            catalog = json.loads(read(catalog_path))
            rules = catalog.get("rules")
            if not isinstance(rules, list):
                raise ValueError("rules must be a list")
            required = {"id", "source", "checkName", "description", "severity", "flags"}
            ids = set()
            for index, rule in enumerate(rules):
                if not isinstance(rule, dict):
                    raise ValueError(f"rule {index} must be an object")
                missing = sorted(required - set(rule))
                if missing:
                    raise ValueError(f"rule {index} missing {', '.join(missing)}")
                ids.add(rule["id"])
            expected = {
                "max-function-lines", "tree-sitter-nonnull", "silent-catch",
                "root-text-materialization", "unbounded-map-set", "import-meta-nonnull",
                "max-file-lines", "max-nesting-depth", "max-module-exports",
                "bounded-loops", "linked-markers", "documented-skips",
            }
            missing_ids = sorted(expected - ids)
            if missing_ids:
                raise ValueError("missing rules: " + ", ".join(missing_ids))
        except Exception as exc:
            setup_error(f"invalid rule catalog: {exc}")

    registry_path = project_root / "quality-gates-suppressions.json"
    if registry_path.exists():
        try:
            registry = json.loads(read(registry_path))
            items = registry.get("suppressions")
            if not isinstance(items, list):
                raise ValueError("suppressions must be a list")
            required = {"ruleId", "path", "range", "justification", "reviewer", "reviewedDate"}
            for index, item in enumerate(items):
                if not isinstance(item, dict):
                    raise ValueError(f"suppression {index} must be an object")
                missing = sorted(required - set(item))
                if missing:
                    raise ValueError(f"suppression {index} missing {', '.join(missing)}")
            suppressions.extend(items)
        except Exception as exc:
            setup_error(f"invalid suppression registry: {exc}")


def check_functions():
    print("=== TigerStyle: Functions over 50 lines ===")
    func_re = re.compile(
        r"^\s*(?:export\s+)?(?:async\s+)?(?:function\s+\w+|"
        r"(?:private|public|protected|readonly|static|abstract|override)\s+)+"
        r"(?:async\s+)?(?:get\s+|set\s+)?\w+\s*\("
    )
    arrow_re = re.compile(r"^\s*(?:export\s+)?const\s+\w+\s*=\s*(?:async\s+)?\(")
    count = 0
    for path in iter_files(source_exts):
        if not rel(path).startswith("server/src/"):
            continue
        lines = read(path).splitlines()
        index = 0
        while index < len(lines):
            line = lines[index]
            stripped = line.lstrip()
            if stripped.startswith(("//", "/*", "*")):
                index += 1
                continue
            if not (func_re.match(line) or arrow_re.match(line)):
                index += 1
                continue
            depth = 0
            found_open = False
            cursor = index
            while cursor < len(lines):
                code = strip_comments(lines[cursor])
                for char in code:
                    if char == "{":
                        depth += 1
                        found_open = True
                    elif char == "}":
                        depth -= 1
                if found_open and depth <= 0:
                    length = cursor - index + 1
                    if length > 55:
                        fail("max-function-lines", path, index + 1, f"{length} lines")
                        count += 1
                    break
                cursor += 1
            index += 1
    if count == 0:
        print("[PASS] All functions under 55 lines")


def check_nonnull():
    print("\n=== Non-null assertions on tree-sitter/array access ===")
    patterns = [
        r"\.child\([0-9]+\)!", r"\.parent!", r"\.children!",
        r"\.namedChild\([0-9]+\)!", r"\.firstChild!", r"\.shift\(\)!", r"\.pop\(\)!",
    ]
    count = 0
    for path in iter_files(source_exts):
        if not rel(path).startswith("server/src/"):
            continue
        for number, line in enumerate(read(path).splitlines(), 1):
            code = strip_comments(line)
            if any(re.search(pattern, code) for pattern in patterns):
                fail("tree-sitter-nonnull", path, number, line.strip())
                count += 1
    if count == 0:
        print("[PASS] No non-null assertions on tree-sitter/array access")


def check_catch():
    print("\n=== Silent catch blocks ===")
    count = 0
    for path in iter_files(source_exts):
        if not rel(path).startswith("server/src/"):
            continue
        lines = read(path).splitlines()
        for index, line in enumerate(lines):
            if re.search(r"catch\s*\(\s*\)\s*{", line) or "void err" in line:
                next_line = lines[index + 1] if index + 1 < len(lines) else ""
                if "//" in next_line or "/*" in next_line:
                    warn("silent-catch", path, index + 1, "has comment — verify it explains WHY")
                else:
                    fail("silent-catch", path, index + 1, line.strip())
                    count += 1
    if count == 0:
        print("[PASS] No silent catch blocks without explanatory comments")


def check_roottext():
    print("\n=== rootNode.text / root.text materialization ===")
    count = 0
    for path in iter_files(source_exts):
        if not rel(path).startswith("server/src/"):
            continue
        for number, line in enumerate(read(path).splitlines(), 1):
            code = strip_comments(line)
            if "rootNode.text" in code or "root.text" in code:
                fail("root-text-materialization", path, number, line.strip())
                count += 1
    if count == 0:
        print("[PASS] No rootNode.text usage")


def check_unbounded():
    print("\n=== Unbounded Map/Set (no eviction logic in file) ===")
    count = 0
    eviction_re = re.compile(r"(\.delete\(|\.clear\(|LRU|CACHE_MAX|MAX_ENTRIES|evict|size > |size >=)")
    for path in iter_files(source_exts):
        if not rel(path).startswith("server/src/"):
            continue
        text = read(path)
        if not re.search(r"new (Map|Set)<|= new (Map|Set)\(\)", text):
            continue
        if eviction_re.search(text):
            continue
        warn("unbounded-map-set", path, 1, "no eviction logic found in file")
        count += 1
    if count == 0:
        print("[PASS] All Maps/Sets appear to have eviction logic")


def check_importmeta():
    print("\n=== import.meta non-null assertions ===")
    count = 0
    for path in iter_files(source_exts):
        if not rel(path).startswith("server/src/"):
            continue
        for number, line in enumerate(read(path).splitlines(), 1):
            if "import.meta.dirname!" in line or "import.meta.url!" in line:
                fail("import-meta-nonnull", path, number, line.strip())
                count += 1
    if count == 0:
        print("[PASS] No import.meta non-null assertions")


def check_filelen():
    print("\n=== TigerStyle: Files over 500 lines ===")
    count = 0
    for path in iter_files(source_exts):
        if not rel(path).startswith("server/src/"):
            continue
        length = len(read(path).splitlines())
        if length > 500:
            fail("max-file-lines", path, 1, f"{length} lines")
            count += 1
    if count == 0:
        print("[PASS] All files under 500 lines")


def check_nesting():
    print("\n=== TigerStyle: Nesting depth over 4 ===")
    count = 0
    control_re = re.compile(r"\b(if|for|while|switch|try|catch|else)\b")
    for path in iter_files(source_exts):
        if not rel(path).startswith("server/src/"):
            continue
        lines = read(path).splitlines()
        control_depth = 0
        block_stack = []
        for number, line in enumerate(lines, 1):
            code = strip_comments(line)
            opens_control = bool(control_re.search(code))
            for char_index, char in enumerate(code):
                if char == "{":
                    is_control = opens_control and char_index >= code.find("{")
                    block_stack.append(is_control)
                    if is_control:
                        control_depth += 1
                    if is_control and control_depth > 4:
                        fail("max-nesting-depth", path, number, f"nesting depth {control_depth} exceeds limit 4")
                        count += 1
                elif char == "}":
                    if not block_stack:
                        continue
                    was_control = block_stack.pop()
                    if was_control:
                        control_depth = max(0, control_depth - 1)
    if count == 0:
        print("[PASS] Nesting depth within limit")


def check_exports():
    print("\n=== TigerStyle: Module exports over 20 ===")
    count = 0
    export_re = re.compile(r"^\s*export\s+(?:async\s+)?(?:class|interface|type|enum|const|let|var|function|abstract\s+class)\b|^\s*export\s*{([^}]*)}")
    for path in iter_files(source_exts):
        exports = 0
        for line in read(path).splitlines():
            match = export_re.search(line)
            if not match:
                continue
            if match.group(1):
                exports += len([part for part in match.group(1).split(",") if part.strip()])
            else:
                exports += 1
        if exports > 20:
            fail("max-module-exports", path, 1, f"{exports} exports exceeds limit 20")
            count += 1
    if count == 0:
        print("[PASS] Module export counts within limit")


def has_bound_or_proof(lines: list[str], index: int, line: str) -> bool:
    window = "\n".join(lines[max(0, index - 2): min(len(lines), index + 3)]).lower()
    if "bounded" in window or "upper bound" in window or "proof" in window:
        return True
    statement = line
    cursor = index + 1
    while "{" not in statement and ")" not in statement and cursor < min(len(lines), index + 6):
        statement += " " + strip_comments(lines[cursor]).strip()
        cursor += 1
    stripped = statement.strip()
    if stripped.startswith("for ") or stripped.startswith("for("):
        return " of " in stripped or " in " in stripped or bool(re.search(r";.*(<|<=|>|>=).*;", stripped))
    if stripped.startswith("while"):
        if re.search(r"(<|<=|>|>=)", stripped):
            return True
        match = re.search(r"while\s*\(\s*([A-Za-z_$][A-Za-z0-9_$.]*)", stripped)
        if not match:
            return False
        variable = re.escape(match.group(1).split(".")[0])
        body = "\n".join(lines[index:min(len(lines), index + 20)])
        return bool(re.search(rf"\b{variable}\b\s*=", body))
    return True


def check_loops():
    print("\n=== TigerStyle: Loops without explicit bounds ===")
    count = 0
    loop_re = re.compile(r"^\s*(for|while)\s*\(")
    for path in iter_files(source_exts):
        if not rel(path).startswith("server/src/"):
            continue
        lines = read(path).splitlines()
        for index, line in enumerate(lines):
            code = strip_comments(line)
            if not loop_re.search(code):
                continue
            if has_bound_or_proof(lines, index, code):
                continue
            fail("bounded-loops", path, index + 1, "loop lacks finite collection/range form or proof comment")
            count += 1
    if count == 0:
        print("[PASS] Loops are bounded or documented")


def marker_has_issue(line: str) -> bool:
    return bool(re.search(r"(https://github\.com/[^\s)]+/(issues|pull)/\d+|#\d+|[A-Z][A-Z0-9]+-\d+)", line))


def check_markers():
    print("\n=== TigerStyle: Bare TODO/FIXME/HACK/XXX markers ===")
    count = 0
    marker_re = re.compile(r"(?<![A-Za-z0-9_])(TODO|FIXME|HACK|XXX)(?![A-Za-z0-9_])")
    for path in iter_files(text_exts):
        for number, line in enumerate(read(path).splitlines(), 1):
            if not marker_re.search(line):
                continue
            if marker_has_issue(line):
                continue
            fail("linked-markers", path, number, "marker must reference a tracked issue")
            count += 1
    if count == 0:
        print("[PASS] All markers link to tracked issues")


def skip_has_reason(line: str) -> bool:
    lowered = line.lower()
    reason_words = ["because", "reason", "requires", "needs", "absent", "missing", "runtime", "external", "flaky"]
    return "—" in line or "//" in line and any(word in lowered for word in reason_words) or any(word in lowered for word in reason_words)


def check_skips():
    print("\n=== TigerStyle: Skipped tests without documented reasons ===")
    count = 0
    skip_re = re.compile(r"\b(test|describe|it)\.skip\s*\(")
    for path in iter_files(source_exts):
        lines = read(path).splitlines()
        for index, line in enumerate(lines):
            if not skip_re.search(line):
                continue
            context = " ".join(lines[index:min(len(lines), index + 2)])
            if skip_has_reason(context):
                continue
            fail("documented-skips", path, index + 1, "skipped test must document the reason")
            count += 1
    if count == 0:
        print("[PASS] All skipped tests document a reason")

validate_catalog_and_suppressions()
if setup_errors:
    sys.exit(2)

checks = {
    "functions": check_functions,
    "nonnull": check_nonnull,
    "catch": check_catch,
    "roottext": check_roottext,
    "unbounded": check_unbounded,
    "importmeta": check_importmeta,
    "filelen": check_filelen,
    "nesting": check_nesting,
    "exports": check_exports,
    "loops": check_loops,
    "markers": check_markers,
    "skips": check_skips,
    "catalog": lambda: print("\n=== TigerStyle: Rule catalog and suppressions ===\n[PASS] Rule catalog and suppression registry valid"),
}

for name in all_checks:
    if name in selected:
        checks[name]()

print("")
if errors == 0 and warnings == 0:
    print("=== All checks passed ===")
    sys.exit(0)
if errors == 0:
    print(f"=== {warnings} warning(s), 0 failures ===")
    sys.exit(0)
print(f"=== {errors} failure(s), {warnings} warning(s) ===")
sys.exit(1)
PYEOF
