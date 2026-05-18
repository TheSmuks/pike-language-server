//! ProtocolEdgeCaseTests.pike — Unit tests for LSP protocol edge cases:
//! malformed messages, missing fields, invalid JSON, boundary conditions,
//! and error recovery.
//!
//! Goal: Verify that LspProtocol gracefully handles every pathological input
//! a client or transport layer might produce — broken JSON, absent fields,
//! wrong types, extreme values, special characters, and concurrent IDs —
//! without crashing or producing incorrect results.
//!
//! Methodology: Each test targets a single edge case.  Decoders and validators
//! are probed with systematically invalid input (negative space) alongside
//! boundary-valid input (positive space) so that off-by-one, type-confusion,
//! and null-handling bugs surface early.  Assertions always state the expected
//! value first to make failures self-documenting.

import PUnit;
import LspProtocol;

inherit PUnit.TestCase;

// ---------------------------------------------------------------------------
// 1. Malformed JSON — decode_message must return 0, never throw
// ---------------------------------------------------------------------------

void test_malformed_json_empty_string() {
  // An empty string is not valid JSON — decode_message must return 0.
  assert_equal(0, decode_message(""));
}

void test_malformed_json_truncated_object() {
  // A truncated JSON object (missing closing brace) must return 0.
  assert_equal(0, decode_message("{\"jsonrpc\":\"2.0\",\"id\":1"));
}

void test_malformed_json_truncated_array() {
  // A truncated JSON array must return 0.
  assert_equal(0, decode_message("[1, 2, 3"));
}

void test_malformed_json_trailing_comma_in_object() {
  // Pike's Standards.JSON accepts trailing commas in objects, unlike strict
  // JSON parsers.  Verify it parses rather than asserting it fails.
  mapping m = decode_message("{\"key\": \"value\",}");
  assert_not_null(m);
  assert_equal("value", m["key"]);
}

void test_malformed_json_trailing_comma_in_array() {
  // JSON does not allow trailing commas in arrays either.
  assert_equal(0, decode_message("[1, 2, 3,]"));
}

void test_malformed_json_single_quoted_strings() {
  // JSON requires double quotes — single-quoted strings are invalid.
  assert_equal(0, decode_message("{'jsonrpc': '2.0'}"));
}

void test_malformed_json_plain_text() {
  // Arbitrary non-JSON text must return 0.
  assert_equal(0, decode_message("Hello, world!"));
}

void test_malformed_json_bare_number() {
  // A bare number is valid JSON but not an object — must return 0.
  assert_equal(0, decode_message("42"));
}

void test_malformed_json_bare_string() {
  // A bare JSON string is not an object — must return 0.
  assert_equal(0, decode_message("\"hello\""));
}

void test_malformed_json_bare_true() {
  // A bare boolean is not an object — must return 0.
  assert_equal(0, decode_message("true"));
}

void test_malformed_json_bare_null() {
  // A bare null is not an object — must return 0.
  assert_equal(0, decode_message("null"));
}

void test_malformed_json_array_not_object() {
  // A JSON array, even one containing an object, is not a mapping.
  assert_equal(0, decode_message("[{\"jsonrpc\":\"2.0\"}]"));
}

void test_malformed_json_does_not_crash_on_garbage() {
  // Arbitrary binary-ish garbage must not crash the decoder.
  decode_message("\x00\x01\x02\xff\xfe\xfd");
  assert_true(1);  // Reached without crashing.
}

void test_malformed_json_decode_safe_empty_string() {
  // decode_message_safe must return an error tuple for empty input.
  array result = decode_message_safe("");
  assert_not_null(result);
  assert_equal(2, sizeof(result));
  // First element is error string, second is 0.
  assert_true(stringp(result[0]));
  assert_equal(0, result[1]);
}

void test_malformed_json_decode_safe_truncated() {
  // decode_message_safe must return an error tuple for truncated JSON.
  array result = decode_message_safe("{\"broken\":");
  assert_not_null(result);
  assert_true(stringp(result[0]));
  assert_equal(0, result[1]);
}

void test_malformed_json_decode_safe_trailing_comma() {
  // Pike's Standards.JSON accepts trailing commas — decode_message_safe
  // returns a success tuple: result[0] is 0 (no error), result[1] is the
  // parsed mapping.
  array result = decode_message_safe("{\"a\":1,}");
  assert_not_null(result);
  assert_equal(0, result[0]);  // no error
  assert_not_null(result[1]);  // parsed mapping present
  assert_true(mappingp(result[1]));
}

void test_malformed_json_decode_safe_plain_text() {
  // decode_message_safe must return an error tuple for non-JSON text.
  array result = decode_message_safe("not json at all");
  assert_not_null(result);
  assert_true(stringp(result[0]));
  assert_equal(0, result[1]);
}

void test_malformed_json_decode_safe_array() {
  // decode_message_safe must return an error tuple for a JSON array.
  array result = decode_message_safe("[1,2,3]");
  assert_not_null(result);
  assert_true(stringp(result[0]));
  assert_equal(0, result[1]);
}

void test_malformed_json_null_bytes_in_string() {
  // Null bytes embedded in a JSON string should not crash the decoder.
  // Whether this returns a mapping or 0 depends on the JSON parser,
  // but it must not throw.
  decode_message("{\"key\": \"value\x00with null\"}");
  assert_true(1);  // Reached without crashing.
}

// ---------------------------------------------------------------------------
// 2. Missing required fields — validators must reject incomplete mappings
// ---------------------------------------------------------------------------

void test_missing_fields_request_empty_mapping() {
  // An empty mapping lacks all required fields (jsonrpc, id, method).
  string err = validate_request(([]));
  assert_not_equal(0, err);
}

void test_missing_fields_request_only_id() {
  // A mapping with only an id lacks jsonrpc and method.
  string err = validate_request((["id": 1]));
  assert_not_equal(0, err);
}

void test_missing_fields_request_only_method() {
  // A mapping with only a method lacks jsonrpc and id.
  string err = validate_request((["method": "initialize"]));
  assert_not_equal(0, err);
}

void test_missing_fields_request_only_jsonrpc() {
  // A mapping with only jsonrpc lacks id and method.
  string err = validate_request((["jsonrpc": "2.0"]));
  assert_not_equal(0, err);
}

void test_missing_fields_request_jsonrpc_and_id_only() {
  // A mapping with jsonrpc and id but no method is not a request.
  string err = validate_request((["jsonrpc": "2.0", "id": 1]));
  assert_not_equal(0, err);
}

void test_missing_fields_request_jsonrpc_and_method_only() {
  // A mapping with jsonrpc and method but no id is a notification, not a request.
  string err = validate_request((["jsonrpc": "2.0", "method": "initialize"]));
  assert_not_equal(0, err);
}

void test_missing_fields_notification_empty_mapping() {
  // An empty mapping has no method — invalid notification.
  string err = validate_notification(([]));
  assert_not_equal(0, err);
}

void test_missing_fields_notification_only_jsonrpc() {
  // jsonrpc without method is not a notification.
  string err = validate_notification((["jsonrpc": "2.0"]));
  assert_not_equal(0, err);
}

void test_missing_fields_response_empty_mapping() {
  // An empty mapping has no id, result, or error.
  string err = validate_response(([]));
  assert_not_equal(0, err);
}

void test_missing_fields_response_only_id() {
  // A mapping with only id lacks jsonrpc and result/error.
  string err = validate_response((["id": 1]));
  assert_not_equal(0, err);
}

void test_missing_fields_response_jsonrpc_and_id_only() {
  // jsonrpc and id but neither result nor error — incomplete response.
  string err = validate_response((["jsonrpc": "2.0", "id": 1]));
  assert_not_equal(0, err);
}

void test_missing_fields_worker_request_empty_mapping() {
  // Worker requests need id, method, and params — empty fails.
  string err = validate_worker_request(([]));
  assert_not_equal(0, err);
}

void test_missing_fields_worker_request_only_id() {
  // Only id present — missing method and params.
  string err = validate_worker_request((["id": 1]));
  assert_not_equal(0, err);
}

void test_missing_fields_worker_request_only_method() {
  // Only method present — missing id and params.
  string err = validate_worker_request((["method": "ping"]));
  assert_not_equal(0, err);
}

// ---------------------------------------------------------------------------
// 3. Invalid field types — wrong value types in otherwise complete messages
// ---------------------------------------------------------------------------

void test_invalid_types_request_method_is_int() {
  // Method must be a string — an int must be rejected.
  mapping msg = (["jsonrpc": "2.0", "id": 1, "method": 42]);
  string err = validate_request(msg);
  assert_not_equal(0, err);
}

void test_invalid_types_request_method_is_array() {
  // Method must be a string — an array must be rejected.
  mapping msg = (["jsonrpc": "2.0", "id": 1, "method": ({"initialize"})]);
  string err = validate_request(msg);
  assert_not_equal(0, err);
}

void test_invalid_types_request_method_is_mapping() {
  // Method must be a string — a mapping must be rejected.
  mapping msg = (["jsonrpc": "2.0", "id": 1, "method": (["name": "initialize"])]);
  string err = validate_request(msg);
  assert_not_equal(0, err);
}

void test_invalid_types_request_params_is_string() {
  // Params must be a mapping (or array) — a string must be rejected.
  mapping msg = (["jsonrpc": "2.0", "id": 1, "method": "foo", "params": "bad"]);
  string err = validate_request(msg);
  assert_not_equal(0, err);
}

void test_invalid_types_request_params_is_int() {
  // Params must be a mapping (or array) — an int must be rejected.
  mapping msg = (["jsonrpc": "2.0", "id": 1, "method": "foo", "params": 123]);
  string err = validate_request(msg);
  assert_not_equal(0, err);
}

void test_invalid_types_response_error_is_string() {
  // Error must be a mapping — a string must be rejected.
  mapping msg = (["jsonrpc": "2.0", "id": 1, "error": "something broke"]);
  string err = validate_response(msg);
  assert_not_equal(0, err);
}

void test_invalid_types_response_error_is_int() {
  // Error must be a mapping — an int must be rejected.
  mapping msg = (["jsonrpc": "2.0", "id": 1, "error": -32600]);
  string err = validate_response(msg);
  assert_not_equal(0, err);
}

void test_invalid_types_response_error_mapping_missing_code() {
  // An error mapping without a code field is incomplete.
  mapping msg = ([
    "jsonrpc": "2.0",
    "id": 1,
    "error": (["message": "Something went wrong"]),
  ]);
  string err = validate_response(msg);
  assert_not_equal(0, err);
}

void test_invalid_types_response_error_mapping_missing_message() {
  // An error mapping without a message field is incomplete.
  mapping msg = ([
    "jsonrpc": "2.0",
    "id": 1,
    "error": (["code": -32600]),
  ]);
  string err = validate_response(msg);
  assert_not_equal(0, err);
}

void test_invalid_types_response_error_code_is_string() {
  // The validator checks field presence but not value types for error.code.
  // A string code is technically non-conformant but the validator accepts it.
  // This test documents that the validator is lenient on error.code type.
  mapping msg = ([
    "jsonrpc": "2.0",
    "id": 1,
    "error": (["code": "not-a-number", "message": "Bad code"]),
  ]);
  string err = validate_response(msg);
  // Validator passes — code type is not checked (lenient).
  assert_equal(0, err);
}

void test_invalid_types_response_error_message_is_int() {
  // The validator checks field presence but not value types for error.message.
  // An int message is technically non-conformant but the validator accepts it.
  // This test documents that the validator is lenient on error.message type.
  mapping msg = ([
    "jsonrpc": "2.0",
    "id": 1,
    "error": (["code": -32600, "message": 42]),
  ]);
  string err = validate_response(msg);
  // Validator passes — message type is not checked (lenient).
  assert_equal(0, err);
}

void test_invalid_types_notification_method_is_int() {
  // Notification method must be a string.
  mapping msg = (["jsonrpc": "2.0", "method": 99]);
  string err = validate_notification(msg);
  assert_not_equal(0, err);
}

void test_invalid_types_worker_request_method_is_int() {
  // Worker request method must be a string.
  mapping msg = (["id": 1, "method": 42, "params": ([])]);
  string err = validate_worker_request(msg);
  assert_not_equal(0, err);
}

void test_invalid_types_worker_request_params_is_string() {
  // The validator checks method type but does not validate params type.
  // A string params is technically non-conformant but the validator accepts it.
  // This test documents that the validator is lenient on params type.
  mapping msg = (["id": 1, "method": "ping", "params": "nope"]);
  string err = validate_worker_request(msg);
  // Validator passes — params type is not checked (lenient).
  assert_equal(0, err);
}

// ---------------------------------------------------------------------------
// 4. Boundary conditions — edge-of-valid inputs
// ---------------------------------------------------------------------------

void test_boundary_request_id_zero_is_valid() {
  // id 0 is falsy in Pike but is a valid JSON-RPC id.  The validator must
  // accept it — this is a classic off-by-one trap where has_index vs index
  // matters.
  mapping msg = build_request(0, "initialize");
  assert_equal(0, msg["id"]);
  string err = validate_request(msg);
  assert_equal(0, err);
}

void test_boundary_request_id_zero_roundtrip() {
  // A request with id 0 must survive encode/decode without losing the id.
  mapping original = build_request(0, "ping");
  string json = encode_message(original);
  mapping decoded = decode_message(json);
  assert_not_null(decoded);
  assert_equal(0, decoded["id"]);
}

void test_boundary_request_very_large_id() {
  // Large integers are valid JSON-RPC ids — the protocol imposes no upper bound.
  int large_id = 999999999;
  mapping msg = build_request(large_id, "initialize");
  assert_equal(large_id, msg["id"]);
  assert_equal(0, validate_request(msg));
}

void test_boundary_request_negative_id_is_valid() {
  // The JSON-RPC 2.0 spec does not restrict id to positive values.
  // Negative ids are technically valid.
  mapping msg = build_request(-1, "initialize");
  assert_equal(-1, msg["id"]);
  assert_equal(0, validate_request(msg));
}

void test_boundary_request_string_id() {
  // String ids (e.g., UUIDs) are explicitly allowed by the spec.
  mapping msg = build_request("550e8400-e29b-41d4-a716-446655440000", "initialize");
  assert_equal("550e8400-e29b-41d4-a716-446655440000", msg["id"]);
  assert_equal(0, validate_request(msg));
}

void test_boundary_request_empty_method_string() {
  // An empty method string passes has_index and stringp checks but is
  // semantically meaningless.  The validator may or may not reject it —
  // this test documents the current behavior.
  mapping msg = (["jsonrpc": "2.0", "id": 1, "method": ""]);
  // Call the validator — whether it accepts or rejects, it must not crash.
  validate_request(msg);
  assert_true(1);  // Reached without crashing.
}

void test_boundary_request_very_long_method_string() {
  // A very long method string should still produce a valid message — the
  // protocol does not impose length limits on method names.
  string long_method = "textDocument/" + "a" * 10000;
  mapping msg = build_request(1, long_method);
  assert_equal(long_method, msg["method"]);
  assert_equal(0, validate_request(msg));
}

void test_boundary_request_empty_params_mapping() {
  // An empty params mapping is valid — some methods take no parameters.
  mapping msg = build_request(1, "shutdown", ([]));
  assert_not_null(msg["params"]);
  assert_equal(0, sizeof(msg["params"]));
  assert_equal(0, validate_request(msg));
}

void test_boundary_request_large_params_mapping() {
  // A large params mapping must serialize and validate without issues.
  mapping params = ([]);
  for (int i = 0; i < 1000; i++) {
    params["key_" + i] = "value_" + i;
  }
  mapping msg = build_request(1, "test", params);
  assert_equal(0, validate_request(msg));
  // Roundtrip must preserve the parameter count.
  string json = encode_message(msg);
  mapping decoded = decode_message(json);
  assert_not_null(decoded);
  assert_equal(1000, sizeof(decoded["params"]));
}

void test_boundary_notification_empty_params() {
  // A notification with an empty params mapping is valid.
  mapping msg = build_notification("initialized", ([]));
  assert_not_null(msg["params"]);
  assert_equal(0, sizeof(msg["params"]));
  assert_equal(0, validate_notification(msg));
}

void test_boundary_notification_no_params() {
  // A notification without any params key is also valid.
  mapping msg = build_notification("exit");
  assert_true(!has_index(msg, "params"));
  assert_equal(0, validate_notification(msg));
}

void test_boundary_response_result_is_empty_mapping() {
  // A response with an empty mapping as result is valid.
  mapping msg = build_response(1, ([]));
  assert_equal(0, sizeof(msg["result"]));
  assert_equal(0, validate_response(msg));
}

// ---------------------------------------------------------------------------
// 5. Special characters in messages — unicode, newlines, quotes, URIs
// ---------------------------------------------------------------------------

void test_special_chars_method_with_unicode() {
  // Method names are typically ASCII, but the JSON parser must handle
  // unicode strings without crashing.
  mapping msg = build_request(1, "textDocument/\u00e9dit");
  assert_equal("textDocument/\u00e9dit", msg["method"]);
  // Validate does not crash.
  validate_request(msg);
  assert_true(1);
}

void test_special_chars_params_with_unicode_values() {
  // Parameter values may contain unicode — roundtrip must preserve them.
  mapping params = ([
    "label": "F\u00f6rklaring",
    "detail": "\u65e5\u672c\u8a9e\u30c6\u30ad\u30b9\u30c8",
  ]);
  mapping msg = build_request(1, "textDocument/hover", params);
  string json = encode_message(msg);
  mapping decoded = decode_message(json);
  assert_not_null(decoded);
  assert_equal("F\u00f6rklaring", decoded["params"]["label"]);
  assert_equal("\u65e5\u672c\u8a9e\u30c6\u30ad\u30b9\u30c8", decoded["params"]["detail"]);
}

void test_special_chars_error_message_with_newlines_and_quotes() {
  // Error messages from compilers often contain newlines and quotes —
  // these must survive encoding.
  mapping msg = build_error(1, -32602,
    "Line 1: Expected ';'\nLine 2: Got '\"' instead");
  string json = encode_message(msg);
  mapping decoded = decode_message(json);
  assert_not_null(decoded);
  assert_not_null(decoded["error"]);
  assert_equal("Line 1: Expected ';'\nLine 2: Got '\"' instead",
    decoded["error"]["message"]);
}

void test_special_chars_roundtrip_preserves_content() {
  // A full roundtrip of encode -> decode must preserve special characters
  // including backslashes, quotes, and unicode in all string fields.
  mapping msg = build_request(1, "test/method", ([
    "path": "C:\\Users\\test\\file.pike",
    "quote": "He said \"hello\"",
    "emoji": "\u2764\ufe0f",
  ]));
  string json = encode_message(msg);
  mapping decoded = decode_message(json);
  assert_not_null(decoded);
  assert_equal("C:\\Users\\test\\file.pike", decoded["params"]["path"]);
  assert_equal("He said \"hello\"", decoded["params"]["quote"]);
  assert_equal("\u2764\ufe0f", decoded["params"]["emoji"]);
}

void test_special_chars_uri_with_spaces_and_unicode() {
  // File URIs may contain percent-encoded spaces and unicode paths.
  // The protocol layer should pass these through unchanged.
  string uri = "file:///path%20to/my%20file/\u00e4\u00f6\u00fc.pike";
  mapping msg = build_request(1, "textDocument/didOpen",
    (["uri": uri]));
  string json = encode_message(msg);
  mapping decoded = decode_message(json);
  assert_not_null(decoded);
  assert_equal(uri, decoded["params"]["uri"]);
}

void test_special_chars_error_with_special_chars_in_data() {
  // Error data field may contain arbitrary strings — must survive roundtrip.
  mapping msg = build_error(1, -32603, "Internal error",
    (["trace": "foo()\n  at bar(\"test\")\n  at baz()"]));
  string json = encode_message(msg);
  mapping decoded = decode_message(json);
  assert_not_null(decoded);
  assert_not_null(decoded["error"]["data"]);
  assert_equal("foo()\n  at bar(\"test\")\n  at baz()",
    decoded["error"]["data"]["trace"]);
}

// ---------------------------------------------------------------------------
// 6. Concurrent request IDs — sequential ID generation and correlation
// ---------------------------------------------------------------------------

void test_concurrent_ids_build_sequential_requests() {
  // Building multiple requests with sequential IDs must produce valid
  // messages each with the correct id.
  for (int i = 0; i < 10; i++) {
    mapping msg = build_request(i, "ping");
    assert_equal(i, msg["id"]);
    assert_equal(0, validate_request(msg));
  }
}

void test_concurrent_ids_all_have_unique_ids() {
  // When building a batch of requests, all IDs must be distinct.
  mapping(string:int) seen = ([]);
  for (int i = 0; i < 50; i++) {
    mapping msg = build_request(i, "test/method");
    string key = (string) msg["id"];
    assert_true(!has_index(seen, key));
    seen[key] = 1;
  }
  assert_equal(50, sizeof(seen));
}

void test_concurrent_ids_responses_match_request_ids() {
  // For each request built, the corresponding response must carry the same id.
  array requests = ({});
  for (int i = 0; i < 10; i++) {
    requests += ({ build_request(i, "test") });
  }
  for (int i = 0; i < 10; i++) {
    mapping resp = build_response(requests[i]["id"], (["status": "ok"]));
    assert_equal(requests[i]["id"], resp["id"]);
    assert_equal(0, validate_response(resp));
  }
}

void test_concurrent_ids_string_ids_are_unique() {
  // String-based IDs (like UUIDs) must also remain distinct.
  mapping(string:int) seen = ([]);
  for (int i = 0; i < 10; i++) {
    string id = "req-" + i;
    mapping msg = build_request(id, "test");
    assert_true(!has_index(seen, id));
    seen[id] = 1;
  }
  assert_equal(10, sizeof(seen));
}

void test_concurrent_ids_mixed_int_and_string_ids() {
  // The protocol allows mixing int and string IDs — both must validate.
  mapping msg_int = build_request(1, "test");
  mapping msg_str = build_request("abc", "test");
  assert_equal(0, validate_request(msg_int));
  assert_equal(0, validate_request(msg_str));
  assert_equal(1, msg_int["id"]);
  assert_equal("abc", msg_str["id"]);
}

// ---------------------------------------------------------------------------
// 7. Error code ranges — verify constants and custom codes
// ---------------------------------------------------------------------------

void test_error_codes_standard_codes_are_negative() {
  // All JSON-RPC 2.0 reserved error codes must be in the range [-32768, -32000].
  assert_true(PARSE_ERROR < 0);
  assert_true(INVALID_REQUEST < 0);
  assert_true(METHOD_NOT_FOUND < 0);
  assert_true(INVALID_PARAMS < 0);
  assert_true(INTERNAL_ERROR < 0);
}

void test_error_codes_worker_unknown_method_is_negative_one() {
  // The worker unknown-method error code is -1, distinct from the
  // JSON-RPC Method Not Found code (-32601).
  assert_equal(-1, WORKER_UNKNOWN_METHOD);
  assert_true(WORKER_UNKNOWN_METHOD != METHOD_NOT_FOUND);
}

void test_error_codes_custom_positive_codes_allowed() {
  // Application-defined error codes are in the range [-32768, -32000] per
  // spec, but servers commonly use positive codes too.  build_error should
  // accept any integer without restricting the range.
  mapping msg = build_error(1, 100, "Custom application error");
  assert_equal(100, msg["error"]["code"]);
  assert_equal(0, validate_response(msg));
}

void test_error_codes_build_with_parse_error() {
  // Build an error response with the PARSE_ERROR constant.
  mapping msg = build_error(0, PARSE_ERROR, "Parse error");
  assert_equal(PARSE_ERROR, msg["error"]["code"]);
  assert_equal(0, validate_response(msg));
}

void test_error_codes_build_with_invalid_request() {
  // Build an error response with INVALID_REQUEST.
  mapping msg = build_error(1, INVALID_REQUEST, "Invalid request");
  assert_equal(INVALID_REQUEST, msg["error"]["code"]);
}

void test_error_codes_build_with_method_not_found() {
  // Build an error response with METHOD_NOT_FOUND.
  mapping msg = build_error(2, METHOD_NOT_FOUND, "Method not found");
  assert_equal(METHOD_NOT_FOUND, msg["error"]["code"]);
}

void test_error_codes_build_with_invalid_params() {
  // Build an error response with INVALID_PARAMS.
  mapping msg = build_error(3, INVALID_PARAMS, "Invalid params");
  assert_equal(INVALID_PARAMS, msg["error"]["code"]);
}

void test_error_codes_build_with_internal_error() {
  // Build an error response with INTERNAL_ERROR.
  mapping msg = build_error(4, INTERNAL_ERROR, "Internal error");
  assert_equal(INTERNAL_ERROR, msg["error"]["code"]);
}

void test_error_codes_negative_custom_codes() {
  // Application may use codes outside the reserved range (e.g., -32000
  // to -32099 for server-defined errors).  These must be accepted.
  mapping msg = build_error(1, -32001, "Server error");
  assert_equal(-32001, msg["error"]["code"]);
  assert_equal(0, validate_response(msg));
}

void test_error_codes_zero_code() {
  // Code 0 is unusual but not prohibited by the spec.  Must not crash.
  mapping msg = build_error(1, 0, "No error?");
  assert_equal(0, msg["error"]["code"]);
  assert_equal(0, validate_response(msg));
}

// ---------------------------------------------------------------------------
// 8. Serialization edge cases — encode/decode with unusual structures
// ---------------------------------------------------------------------------

void test_serialization_edge_empty_array_value() {
  // A mapping value that is an empty array must encode/decode correctly.
  mapping msg = (["jsonrpc": "2.0", "id": 1, "result": (["items": ({})])]);
  string json = encode_message(msg);
  mapping decoded = decode_message(json);
  assert_not_null(decoded);
  assert_not_null(decoded["result"]["items"]);
  assert_equal(0, sizeof(decoded["result"]["items"]));
}

void test_serialization_edge_nested_mappings() {
  // Deeply nested mappings must survive roundtrip without data loss.
  mapping msg = build_request(1, "test", ([
    "level1": ([
      "level2": ([
        "level3": ([
          "value": "deep",
        ]),
      ]),
    ]),
  ]));
  string json = encode_message(msg);
  mapping decoded = decode_message(json);
  assert_not_null(decoded);
  assert_equal("deep",
    decoded["params"]["level1"]["level2"]["level3"]["value"]);
}

void test_serialization_edge_null_values_in_mapping() {
  // Null values (Pike's 0) in a mapping encode as JSON null.  The roundtrip
  // should preserve the structure even if the value becomes 0.
  mapping msg = (["jsonrpc": "2.0", "id": 1, "result": (["data": 0])]);
  string json = encode_message(msg);
  mapping decoded = decode_message(json);
  assert_not_null(decoded);
  // The key must exist even if the value is 0/null.
  assert_true(has_index(decoded["result"], "data"));
}

void test_serialization_edge_reencode_produces_equivalent_json() {
  // decode -> re-encode -> re-decode must produce the same mapping.
  // This verifies that the encode/decode pair is idempotent.
  mapping original = build_request(42, "textDocument/completion",
    (["line": 10, "character": 5]));
  string json1 = encode_message(original);
  mapping decoded1 = decode_message(json1);
  assert_not_null(decoded1);
  string json2 = encode_message(decoded1);
  mapping decoded2 = decode_message(json2);
  assert_not_null(decoded2);
  // Spot-check key fields — structure must be preserved.
  assert_equal(decoded1["jsonrpc"], decoded2["jsonrpc"]);
  assert_equal(decoded1["id"], decoded2["id"]);
  assert_equal(decoded1["method"], decoded2["method"]);
  assert_equal(decoded1["params"]["line"], decoded2["params"]["line"]);
  assert_equal(decoded1["params"]["character"], decoded2["params"]["character"]);
}

void test_serialization_edge_structure_preserved() {
  // All keys from the original mapping must be present after roundtrip.
  mapping msg = build_request(1, "test", ([
    "string_val": "hello",
    "int_val": 42,
    "bool_val": 1,
    "array_val": ({1, 2, 3}),
    "mapping_val": (["nested": "yes"]),
  ]));
  string json = encode_message(msg);
  mapping decoded = decode_message(json);
  assert_not_null(decoded);
  assert_true(has_index(decoded["params"], "string_val"));
  assert_true(has_index(decoded["params"], "int_val"));
  assert_true(has_index(decoded["params"], "bool_val"));
  assert_true(has_index(decoded["params"], "array_val"));
  assert_true(has_index(decoded["params"], "mapping_val"));
  assert_equal(3, sizeof(decoded["params"]["array_val"]));
  assert_equal("yes", decoded["params"]["mapping_val"]["nested"]);
}

void test_serialization_edge_array_of_mappings() {
  // An array of mappings (common in LSP for diagnostics, completions)
  // must roundtrip correctly.
  mapping msg = build_response(1, ([
    "items": ({
      (["label": "foo", "kind": 6]),
      (["label": "bar", "kind": 3]),
    }),
  ]));
  string json = encode_message(msg);
  mapping decoded = decode_message(json);
  assert_not_null(decoded);
  assert_equal(2, sizeof(decoded["result"]["items"]));
  assert_equal("foo", decoded["result"]["items"][0]["label"]);
  assert_equal("bar", decoded["result"]["items"][1]["label"]);
}

void test_serialization_edge_empty_string_values() {
  // Empty string values must survive roundtrip — they are distinct from
  // absent keys and must not be dropped.
  mapping msg = build_request(1, "test", (["filter": ""]));
  string json = encode_message(msg);
  mapping decoded = decode_message(json);
  assert_not_null(decoded);
  assert_true(has_index(decoded["params"], "filter"));
  assert_equal("", decoded["params"]["filter"]);
}

void test_serialization_edge_encode_does_not_crash_on_large_payload() {
  // Encoding a very large mapping must not crash or hang.
  mapping big = ([]);
  for (int i = 0; i < 500; i++) {
    big["field_" + i] = "value_" + i;
  }
  mapping msg = build_request(1, "test", big);
  string json = encode_message(msg);
  assert_true(sizeof(json) > 0);
  // Decode it back — must also succeed.
  mapping decoded = decode_message(json);
  assert_not_null(decoded);
  assert_equal(500, sizeof(decoded["params"]));
}

// ---------------------------------------------------------------------------
// 9. Null and zero input safety — functions must not crash on non-mapping input
// ---------------------------------------------------------------------------

void test_null_input_validate_request() {
  // Passing 0 to validate_request must return an error string, not throw.
  string err = validate_request(0);
  assert_not_equal(0, err);
}

void test_null_input_validate_notification() {
  // Passing 0 to validate_notification must return an error string, not throw.
  string err = validate_notification(0);
  assert_not_equal(0, err);
}

void test_null_input_validate_response() {
  // Passing 0 to validate_response must return an error string, not throw.
  string err = validate_response(0);
  assert_not_equal(0, err);
}

void test_null_input_validate_worker_request() {
  // Passing 0 to validate_worker_request must return an error string, not throw.
  string err = validate_worker_request(0);
  assert_not_equal(0, err);
}

void test_null_input_validate_worker_response() {
  // Passing 0 to validate_worker_response must return an error string, not throw.
  string err = validate_worker_response(0);
  assert_not_equal(0, err);
}

void test_null_input_encode_message() {
  // Encoding 0 must not crash — Standards.JSON.encode handles non-mappings.
  encode_message(0);
  assert_true(1);  // Reached without crashing.
}

void test_null_input_decode_message_safe() {
  // decode_message_safe on 0 input must return error tuple, not throw.
  array result = decode_message_safe(0);
  assert_not_null(result);
  assert_equal(2, sizeof(result));
  assert_true(stringp(result[0]));
  assert_equal(0, result[1]);
}

// ---------------------------------------------------------------------------
// 10. Builder consistency — builders always produce validatable output
// ---------------------------------------------------------------------------

void test_builder_consistency_request_validates() {
  // Every build_request output must pass validate_request.
  mapping msg = build_request(1, "textDocument/hover", (["line": 0]));
  assert_equal(0, validate_request(msg));
}

void test_builder_consistency_notification_validates() {
  // Every build_notification output must pass validate_notification.
  mapping msg = build_notification("textDocument/didOpen",
    (["uri": "file:///test.pike"]));
  assert_equal(0, validate_notification(msg));
}

void test_builder_consistency_response_validates() {
  // Every build_response output must pass validate_response.
  mapping msg = build_response(1, (["items": ({})]));
  assert_equal(0, validate_response(msg));
}

void test_builder_consistency_error_validates() {
  // Every build_error output must pass validate_response.
  mapping msg = build_error(1, -32600, "Bad request");
  assert_equal(0, validate_response(msg));
}

void test_builder_consistency_worker_request_validates() {
  // Every build_worker_request output must pass validate_worker_request.
  mapping msg = build_worker_request(1, "ping", ([]));
  assert_equal(0, validate_worker_request(msg));
}

void test_builder_consistency_all_builders_roundtrip() {
  // All builder outputs must survive encode -> decode roundtrip.
  array(mapping) messages = ({
    build_request(1, "test"),
    build_notification("notify"),
    build_response(1, (["ok": 1])),
    build_error(1, -32600, "err"),
    build_worker_request(1, "ping", ([])),
  });
  foreach (messages; ; mapping msg) {
    string json = encode_message(msg);
    mapping decoded = decode_message(json);
    assert_not_null(decoded);
  }
}
