//! WorkerProtocolTests.pike — Unit tests for the worker.pike IPC protocol.
//!
//! Goal: Verify that every builder, validator, and serializer for the worker IPC
//! protocol (the simplified JSON-RPC-like protocol between the TypeScript LSP
//! server and the Pike worker subprocess) conforms to the expected message
//! format.  This includes request/response construction, field validation,
//! method-specific param and result structures, unknown-method error handling,
//! and encode/decode round-trips.
//!
//! Methodology: Each test targets a single behavior — builders produce mappings
//! with the correct keys and values, validators accept valid messages and reject
//! specific invalid mutations, serializers round-trip without data loss, and
//! error responses match the worker.pike contract.  Positive and negative spaces
//! are both exercised so boundary bugs are caught early.

import PUnit;
import LspProtocol;

inherit PUnit.TestCase;

// ---------------------------------------------------------------------------
// 1. Worker request format — build_worker_request / validate_worker_request
// ---------------------------------------------------------------------------

void test_worker_request_build_diagnose() {
  // The diagnose method is the primary operation — it must build a valid
  // request with id, method, and params.
  mapping msg = build_worker_request(1, "diagnose",
    (["source": "int main() { return 0; }", "file": "/tmp/test.pike"]));
  assert_equal(1, msg["id"]);
  assert_equal("diagnose", msg["method"]);
  assert_not_null(msg["params"]);
  assert_equal("/tmp/test.pike", msg["params"]["file"]);
}

void test_worker_request_build_ping() {
  // Ping is the simplest method — empty params, used for health checks.
  mapping msg = build_worker_request(2, "ping", ([]));
  assert_equal(2, msg["id"]);
  assert_equal("ping", msg["method"]);
  assert_not_null(msg["params"]);
}

void test_worker_request_build_typeof() {
  // Typeof queries the inferred type of an expression within source code.
  mapping msg = build_worker_request(3, "typeof",
    (["source": "int x = 42;", "expression": "x"]));
  assert_equal(3, msg["id"]);
  assert_equal("typeof", msg["method"]);
  assert_equal("x", msg["params"]["expression"]);
}

void test_worker_request_build_autodoc() {
  // Autodoc extracts documentation XML from Pike source.
  mapping msg = build_worker_request(4, "autodoc",
    (["source": "//! A doc comment\nint foo() { return 1; }",
      "file": "/tmp/foo.pike"]));
  assert_equal(4, msg["id"]);
  assert_equal("autodoc", msg["method"]);
  assert_equal("/tmp/foo.pike", msg["params"]["file"]);
}

void test_worker_request_build_resolve() {
  // Resolve checks whether a symbol can be resolved.
  mapping msg = build_worker_request(5, "resolve",
    (["symbol": "Stdio.File"]));
  assert_equal(5, msg["id"]);
  assert_equal("resolve", msg["method"]);
  assert_equal("Stdio.File", msg["params"]["symbol"]);
}

void test_worker_request_has_required_fields() {
  // Every worker request must contain id, method, and params — these are
  // the three pillars of the worker IPC format.
  mapping msg = build_worker_request(10, "ping", ([]));
  assert_true(has_index(msg, "id"));
  assert_true(has_index(msg, "method"));
  assert_true(has_index(msg, "params"));
}

void test_worker_request_validate_diagnose_passes() {
  // A well-formed diagnose request must pass validation.
  mapping msg = build_worker_request(1, "diagnose",
    (["source": "int main() { return 0; }", "file": "/tmp/test.pike"]));
  assert_null(validate_worker_request(msg));
}

void test_worker_request_validate_ping_passes() {
  // A well-formed ping request must pass validation.
  mapping msg = build_worker_request(2, "ping", ([]));
  assert_null(validate_worker_request(msg));
}

void test_worker_request_validate_typeof_passes() {
  // A well-formed typeof request must pass validation.
  mapping msg = build_worker_request(3, "typeof",
    (["source": "int x = 42;", "expression": "x"]));
  assert_null(validate_worker_request(msg));
}

void test_worker_request_validate_autodoc_passes() {
  // A well-formed autodoc request must pass validation.
  mapping msg = build_worker_request(4, "autodoc",
    (["source": "int foo() {}", "file": "/tmp/foo.pike"]));
  assert_null(validate_worker_request(msg));
}

void test_worker_request_validate_resolve_passes() {
  // A well-formed resolve request must pass validation.
  mapping msg = build_worker_request(5, "resolve",
    (["symbol": "Stdio.File"]));
  assert_null(validate_worker_request(msg));
}

void test_worker_request_without_method_fails_validation() {
  // A request without a method is meaningless — the worker would not know
  // what operation to perform.
  mapping msg = (["id": 1, "params": ([]) ]);
  assert_not_null(validate_worker_request(msg));
}

void test_worker_request_without_id_fails_validation() {
  // A request without an id cannot be correlated with its response.
  mapping msg = (["method": "ping", "params": ([]) ]);
  assert_not_null(validate_worker_request(msg));
}

void test_worker_request_null_message_fails_validation() {
  // Passing 0 (not a mapping) must produce an error, not crash.
  // The validator guards against null/zero input.
  assert_not_null(validate_worker_request(0));
}

// ---------------------------------------------------------------------------
// 2. Worker response format — build_worker_response / build_worker_error
// ---------------------------------------------------------------------------

void test_worker_response_build_success() {
  // A success response carries the id and a result mapping.
  mapping msg = build_worker_response(1, (["status": "ok"]));
  assert_equal(1, msg["id"]);
  assert_not_null(msg["result"]);
  assert_equal("ok", msg["result"]["status"]);
}

void test_worker_response_build_error() {
  // An error response carries the id and an error mapping with code and message.
  mapping msg = build_worker_error(2, -1, "Something went wrong");
  assert_equal(2, msg["id"]);
  assert_not_null(msg["error"]);
  assert_equal(-1, msg["error"]["code"]);
  assert_equal("Something went wrong", msg["error"]["message"]);
}

void test_worker_response_has_id_field() {
  // Every response, whether success or error, must carry an id so the caller
  // can match it to the original request.
  mapping success = build_worker_response(42, ([]));
  mapping error = build_worker_error(43, -1, "err");
  assert_true(has_index(success, "id"));
  assert_true(has_index(error, "id"));
}

void test_worker_response_success_has_result_field() {
  // A success response must contain a "result" key.
  mapping msg = build_worker_response(1, (["status": "ok"]));
  assert_true(has_index(msg, "result"));
}

void test_worker_response_error_has_error_mapping() {
  // An error response must contain an "error" key whose value is a mapping
  // with both "code" and "message".
  mapping msg = build_worker_error(1, -1, "bad");
  assert_true(has_index(msg, "error"));
  assert_true(has_index(msg["error"], "code"));
  assert_true(has_index(msg["error"], "message"));
}

void test_worker_response_validate_success_passes() {
  // A well-formed success response must pass validation.
  mapping msg = build_worker_response(1, (["status": "ok"]));
  assert_null(validate_worker_response(msg));
}

void test_worker_response_validate_error_passes() {
  // A well-formed error response must pass validation.
  mapping msg = build_worker_error(1, -1, "Unknown method: foo");
  assert_null(validate_worker_response(msg));
}

void test_worker_response_without_result_or_error_fails_validation() {
  // A response with neither result nor error is incomplete — the caller
  // cannot determine the outcome of the request.
  mapping msg = (["id": 1]);
  assert_not_null(validate_worker_response(msg));
}

void test_worker_response_null_message_fails_validation() {
  // Passing 0 must produce an error, not crash.
  assert_not_null(validate_worker_response(0));
}

// ---------------------------------------------------------------------------
// 3. Diagnose method messages
// ---------------------------------------------------------------------------

void test_diagnose_request_minimal_params() {
  // Diagnose requires at minimum source and file.  Additional flags like
  // strict, module_paths, include_paths, program_paths are optional.
  mapping msg = build_worker_request(1, "diagnose",
    (["source": "int main() { return 0; }", "file": "/tmp/test.pike"]));
  assert_equal("diagnose", msg["method"]);
  assert_equal("int main() { return 0; }", msg["params"]["source"]);
  assert_equal("/tmp/test.pike", msg["params"]["file"]);
  // Optional params should not be present when not supplied.
  assert_true(!has_index(msg["params"], "strict"));
}

void test_diagnose_request_all_params() {
  // Diagnose with all optional parameters: strict mode, module paths,
  // include paths, and program paths.  The worker uses these to configure
  // the Pike compiler environment.
  mapping msg = build_worker_request(2, "diagnose", ([
    "source": "int main() { return 0; }",
    "file": "/tmp/test.pike",
    "strict": 1,
    "module_paths": ({"/usr/lib/pike/modules"}),
    "include_paths": ({"/usr/include/pike"}),
    "program_paths": ({"/usr/lib/pike/programs"}),
  ]));
  assert_equal(1, msg["params"]["strict"]);
  assert_equal(1, sizeof(msg["params"]["module_paths"]));
  assert_equal(1, sizeof(msg["params"]["include_paths"]));
  assert_equal(1, sizeof(msg["params"]["program_paths"]));
}

void test_diagnose_response_structure_no_errors() {
  // A successful diagnose response with exit_code 0 and an empty diagnostics
  // array means the source compiled cleanly.
  mapping msg = build_worker_response(1, ([
    "diagnostics": ({}),
    "exit_code": 0,
  ]));
  assert_not_null(msg["result"]);
  assert_equal(0, msg["result"]["exit_code"]);
  assert_equal(0, sizeof(msg["result"]["diagnostics"]));
  assert_null(validate_worker_response(msg));
}

void test_diagnose_response_structure_with_errors() {
  // A diagnose response with exit_code 1 and populated diagnostics array
  // indicates compilation errors.  Each diagnostic should carry at minimum
  // a message; the full structure is defined by the LSP Diagnostic type.
  mapping msg = build_worker_response(2, ([
    "diagnostics": ({
      (["message": "Expected ';'", "line": 3, "severity": 1]),
    }),
    "exit_code": 1,
  ]));
  assert_equal(1, msg["result"]["exit_code"]);
  assert_equal(1, sizeof(msg["result"]["diagnostics"]));
  assert_equal("Expected ';'", msg["result"]["diagnostics"][0]["message"]);
}

void test_diagnose_response_has_diagnostics_and_exit_code() {
  // The diagnose result must always contain both diagnostics and exit_code
  // keys, regardless of whether errors were found.
  mapping result = (["diagnostics": ({}), "exit_code": 0]);
  mapping msg = build_worker_response(3, result);
  assert_true(has_index(msg["result"], "diagnostics"));
  assert_true(has_index(msg["result"], "exit_code"));
}

// ---------------------------------------------------------------------------
// 4. Ping method messages
// ---------------------------------------------------------------------------

void test_ping_request_empty_params() {
  // Ping takes no parameters — the empty mapping is the canonical form.
  mapping msg = build_worker_request(1, "ping", ([]));
  assert_equal("ping", msg["method"]);
  assert_equal(0, sizeof(msg["params"]));
}

void test_ping_response_structure() {
  // A successful ping response reports status "ok" and the Pike version
  // string.  The TypeScript server uses this for health checks and version
  // capability detection.
  mapping msg = build_worker_response(1, ([
    "status": "ok",
    "pike_version": "8.0.1738",
  ]));
  assert_equal("ok", msg["result"]["status"]);
  assert_equal("8.0.1738", msg["result"]["pike_version"]);
  assert_null(validate_worker_response(msg));
}

void test_ping_response_has_status_and_version() {
  // The ping result must contain both status and pike_version keys.
  mapping result = (["status": "ok", "pike_version": "8.0.1738"]);
  mapping msg = build_worker_response(1, result);
  assert_true(has_index(msg["result"], "status"));
  assert_true(has_index(msg["result"], "pike_version"));
}

// ---------------------------------------------------------------------------
// 5. Typeof method messages
// ---------------------------------------------------------------------------

void test_typeof_request_with_source_and_expression() {
  // Typeof requires both source (the Pike code) and expression (the symbol
  // or expression whose type should be inferred).
  mapping msg = build_worker_request(1, "typeof",
    (["source": "string s = \"hello\";", "expression": "s"]));
  assert_equal("typeof", msg["method"]);
  assert_equal("string s = \"hello\";", msg["params"]["source"]);
  assert_equal("s", msg["params"]["expression"]);
}

void test_typeof_success_response_with_type() {
  // A successful typeof response contains the inferred type as a string.
  mapping msg = build_worker_response(1, (["type": "string"]));
  assert_equal("string", msg["result"]["type"]);
  assert_true(!has_index(msg["result"], "error"));
}

void test_typeof_error_response() {
  // A typeof error response indicates the type could not be inferred,
  // for example if the expression does not exist in the source.
  mapping msg = build_worker_response(2, ([
    "type": "",
    "error": "Expression 'nonexistent' not found in source",
  ]));
  assert_not_null(msg["result"]["error"]);
  assert_equal("", msg["result"]["type"]);
}

void test_typeof_response_has_type_field() {
  // The typeof result must always contain a "type" key, even on error.
  mapping result = (["type": "int"]);
  mapping msg = build_worker_response(1, result);
  assert_true(has_index(msg["result"], "type"));
}

// ---------------------------------------------------------------------------
// 6. Autodoc method messages
// ---------------------------------------------------------------------------

void test_autodoc_request_with_source_and_file() {
  // Autodoc requires source code and a file path.  The file path is used
  // for context when extracting documentation.
  mapping msg = build_worker_request(1, "autodoc",
    (["source": "//! Doc\nint foo() { return 1; }",
      "file": "/tmp/foo.pike"]));
  assert_equal("autodoc", msg["method"]);
  assert_not_null(msg["params"]["source"]);
  assert_not_null(msg["params"]["file"]);
}

void test_autodoc_success_response_with_xml() {
  // A successful autodoc response contains the extracted documentation
  // as an XML string.
  mapping msg = build_worker_response(1, ([
    "xml": "<autodoc><doc><text>Doc</text></doc></autodoc>",
  ]));
  assert_not_null(msg["result"]["xml"]);
  assert_true(sizeof(msg["result"]["xml"]) > 0);
  assert_true(!has_index(msg["result"], "error"));
}

void test_autodoc_error_response() {
  // An autodoc error response indicates extraction failed, for example
  // if the source has no documentation comments.
  mapping msg = build_worker_response(2, ([
    "xml": "",
    "error": "No autodoc found in source",
  ]));
  assert_not_null(msg["result"]["error"]);
  assert_equal("", msg["result"]["xml"]);
}

void test_autodoc_response_has_xml_field() {
  // The autodoc result must always contain an "xml" key, even if empty.
  mapping result = (["xml": "<autodoc/>"]);
  mapping msg = build_worker_response(1, result);
  assert_true(has_index(msg["result"], "xml"));
}

// ---------------------------------------------------------------------------
// 7. Resolve method messages
// ---------------------------------------------------------------------------

void test_resolve_request_with_symbol() {
  // Resolve takes a single symbol name to check whether it can be
  // resolved in the Pike runtime environment.
  mapping msg = build_worker_request(1, "resolve",
    (["symbol": "Stdio.File"]));
  assert_equal("resolve", msg["method"]);
  assert_equal("Stdio.File", msg["params"]["symbol"]);
}

void test_resolve_success_response() {
  // A successful resolve response indicates the symbol was found.
  mapping msg = build_worker_response(1, ([
    "resolved": 1,
    "symbol": "Stdio.File",
  ]));
  assert_equal(1, msg["result"]["resolved"]);
  assert_equal("Stdio.File", msg["result"]["symbol"]);
  assert_true(!has_index(msg["result"], "error"));
}

void test_resolve_error_response_missing_symbol() {
  // A resolve error response indicates the symbol could not be found.
  mapping msg = build_worker_response(2, ([
    "resolved": 0,
    "error": "Symbol 'Nonexistent.Module' not found",
  ]));
  assert_equal(0, msg["result"]["resolved"]);
  assert_not_null(msg["result"]["error"]);
}

void test_resolve_response_has_resolved_field() {
  // The resolve result must always contain a "resolved" boolean key.
  mapping result = (["resolved": 1]);
  mapping msg = build_worker_response(1, result);
  assert_true(has_index(msg["result"], "resolved"));
}

// ---------------------------------------------------------------------------
// 8. Unknown method handling
// ---------------------------------------------------------------------------

void test_unknown_method_request_builds_normally() {
  // The builder does not validate method names — it produces a well-formed
  // request regardless.  Method validation is the worker's responsibility.
  mapping msg = build_worker_request(1, "fly_to_the_moon", ([]));
  assert_equal("fly_to_the_moon", msg["method"]);
  assert_null(validate_worker_request(msg));
}

void test_unknown_method_error_response_code() {
  // When the worker encounters an unknown method, it returns error code -1.
  // This is distinct from JSON-RPC 2.0's Method Not Found (-32601).
  mapping msg = build_worker_error(1, -1, "Unknown method: fly_to_the_moon");
  assert_equal(-1, msg["error"]["code"]);
  assert_null(validate_worker_response(msg));
}

void test_unknown_method_error_response_contains_method_name() {
  // The error message must include the unknown method name so the caller
  // can diagnose the problem without cross-referencing the original request.
  string method_name = "teleport";
  mapping msg = build_worker_error(1, -1,
    "Unknown method: " + method_name);
  assert_true(search(msg["error"]["message"], method_name) >= 0);
}

void test_unknown_method_error_matches_worker_constant() {
  // The worker unknown-method error code should match the WORKER_UNKNOWN_METHOD
  // constant defined in LspProtocol.
  assert_equal(-1, WORKER_UNKNOWN_METHOD);
  mapping msg = build_worker_error(1, WORKER_UNKNOWN_METHOD,
    "Unknown method: foo");
  assert_equal(WORKER_UNKNOWN_METHOD, msg["error"]["code"]);
}

// ---------------------------------------------------------------------------
// 9. Request serialization — encode_message / decode_message roundtrips
// ---------------------------------------------------------------------------

void test_worker_serialization_diagnose_roundtrip() {
  // Encoding and then decoding a diagnose request must preserve all fields
  // including nested params.
  mapping original = build_worker_request(1, "diagnose", ([
    "source": "int main() { return 1; }",
    "file": "/tmp/roundtrip.pike",
    "strict": 1,
  ]));
  string json = encode_message(original);
  mapping decoded = decode_message(json);
  assert_not_null(decoded);
  assert_equal(1, decoded["id"]);
  assert_equal("diagnose", decoded["method"]);
  assert_equal("/tmp/roundtrip.pike", decoded["params"]["file"]);
  assert_equal(1, decoded["params"]["strict"]);
}

void test_worker_serialization_ping_roundtrip() {
  // Ping roundtrip must preserve the empty params mapping.
  mapping original = build_worker_request(2, "ping", ([]));
  string json = encode_message(original);
  mapping decoded = decode_message(json);
  assert_not_null(decoded);
  assert_equal(2, decoded["id"]);
  assert_equal("ping", decoded["method"]);
}

void test_worker_serialization_typeof_roundtrip() {
  // Typeof roundtrip must preserve source and expression.
  mapping original = build_worker_request(3, "typeof",
    (["source": "int x = 42;", "expression": "x"]));
  string json = encode_message(original);
  mapping decoded = decode_message(json);
  assert_not_null(decoded);
  assert_equal("typeof", decoded["method"]);
  assert_equal("int x = 42;", decoded["params"]["source"]);
  assert_equal("x", decoded["params"]["expression"]);
}

void test_worker_serialization_autodoc_roundtrip() {
  // Autodoc roundtrip must preserve source and file.
  mapping original = build_worker_request(4, "autodoc",
    (["source": "//! Doc\nint foo() {}", "file": "/tmp/doc.pike"]));
  string json = encode_message(original);
  mapping decoded = decode_message(json);
  assert_not_null(decoded);
  assert_equal("autodoc", decoded["method"]);
  assert_equal("/tmp/doc.pike", decoded["params"]["file"]);
}

void test_worker_serialization_resolve_roundtrip() {
  // Resolve roundtrip must preserve the symbol name.
  mapping original = build_worker_request(5, "resolve",
    (["symbol": "Stdio.File"]));
  string json = encode_message(original);
  mapping decoded = decode_message(json);
  assert_not_null(decoded);
  assert_equal("resolve", decoded["method"]);
  assert_equal("Stdio.File", decoded["params"]["symbol"]);
}

void test_worker_serialization_success_response_roundtrip() {
  // A success response must roundtrip with its result payload intact.
  mapping original = build_worker_response(10, ([
    "status": "ok",
    "pike_version": "8.0.1738",
  ]));
  string json = encode_message(original);
  mapping decoded = decode_message(json);
  assert_not_null(decoded);
  assert_equal(10, decoded["id"]);
  assert_equal("ok", decoded["result"]["status"]);
  assert_equal("8.0.1738", decoded["result"]["pike_version"]);
}

void test_worker_serialization_error_response_roundtrip() {
  // An error response must roundtrip with its error code and message intact.
  mapping original = build_worker_error(20, -1,
    "Unknown method: warp");
  string json = encode_message(original);
  mapping decoded = decode_message(json);
  assert_not_null(decoded);
  assert_equal(20, decoded["id"]);
  assert_equal(-1, decoded["error"]["code"]);
  assert_equal("Unknown method: warp", decoded["error"]["message"]);
}

void test_worker_serialization_diagnose_result_roundtrip() {
  // A diagnose result with diagnostics array must roundtrip correctly,
  // preserving array elements.
  mapping original = build_worker_response(30, ([
    "diagnostics": ({
      (["message": "Expected ';'", "line": 3]),
    }),
    "exit_code": 1,
  ]));
  string json = encode_message(original);
  mapping decoded = decode_message(json);
  assert_not_null(decoded);
  assert_equal(1, sizeof(decoded["result"]["diagnostics"]));
  assert_equal("Expected ';'", decoded["result"]["diagnostics"][0]["message"]);
  assert_equal(1, decoded["result"]["exit_code"]);
}

void test_worker_serialization_no_jsonrpc_field() {
  // Worker protocol messages do NOT carry a "jsonrpc" field.  This is a
  // deliberate simplification compared to standard JSON-RPC 2.0 — the worker
  // is a subprocess, not a network peer, so version negotiation is unnecessary.
  mapping request = build_worker_request(1, "ping", ([]));
  assert_true(!has_index(request, "jsonrpc"));

  mapping response = build_worker_response(1, (["status": "ok"]));
  assert_true(!has_index(response, "jsonrpc"));

  mapping error = build_worker_error(1, -1, "err");
  assert_true(!has_index(error, "jsonrpc"));
}

void test_worker_serialization_roundtrip_preserves_all_keys() {
  // Roundtrip must not drop or add keys — the decoded mapping must have
  // exactly the same set of top-level keys as the original.
  mapping original = build_worker_request(99, "diagnose", ([
    "source": "int x;",
    "file": "/tmp/x.pike",
  ]));
  string json = encode_message(original);
  mapping decoded = decode_message(json);
  assert_not_null(decoded);
  assert_equal(sizeof(indices(original)), sizeof(indices(decoded)));
  // Verify each expected key is present.
  assert_true(has_index(decoded, "id"));
  assert_true(has_index(decoded, "method"));
  assert_true(has_index(decoded, "params"));
}
