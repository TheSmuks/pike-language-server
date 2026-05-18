//! JsonRpcProtocolTests.pike — Unit tests for JSON-RPC 2.0 message construction,
//! parsing, and validation via the LspProtocol.pmod module.
//!
//! Goal: Verify that every builder, validator, serializer, and error-code constant
//! in LspProtocol conforms to the JSON-RPC 2.0 specification and round-trips
//! correctly through encode/decode.
//!
//! Methodology: Each test targets a single behavior — builders produce mappings
//! with the correct keys and values, validators accept valid messages and reject
//! specific invalid mutations, serializers round-trip without data loss, and
//! constants match the spec values.  Positive and negative spaces are both
//! exercised so boundary bugs are caught early.

import PUnit;
import LspProtocol;

inherit PUnit.TestCase;

// ---------------------------------------------------------------------------
// 1. Request building — build_request(id, method, params)
// ---------------------------------------------------------------------------

void test_build_request_basic_fields() {
  // A minimal request must carry jsonrpc, id, and method.
  mapping msg = build_request(1, "initialize");
  assert_equal("2.0", msg["jsonrpc"]);
  assert_equal(1, msg["id"]);
  assert_equal("initialize", msg["method"]);
}

void test_build_request_with_params() {
  // Params are included when supplied.
  mapping params = (["rootUri": "file:///tmp"]);
  mapping msg = build_request(2, "textDocument/completion", params);
  assert_not_null(msg["params"]);
  assert_equal("file:///tmp", msg["params"]["rootUri"]);
}

void test_build_request_without_params_omits_key() {
  // When no params are given the mapping should not contain a "params" key,
  // because the spec treats absent and present-but-null differently.
  mapping msg = build_request(3, "shutdown");
  assert_true(!has_index(msg, "params"));
}

void test_build_request_accepts_string_id() {
  // JSON-RPC 2.0 allows string identifiers (e.g., UUID-based).
  mapping msg = build_request("abc-123", "textDocument/hover");
  assert_equal("abc-123", msg["id"]);
}

void test_build_request_jsonrpc_version_is_2_0() {
  // Every request must declare protocol version 2.0 exactly.
  mapping msg = build_request(42, "ping");
  assert_equal("2.0", msg["jsonrpc"]);
}

// ---------------------------------------------------------------------------
// 2. Notification building — build_notification(method, params)
// ---------------------------------------------------------------------------

void test_build_notification_basic_fields() {
  // A notification carries jsonrpc and method but never an id.
  mapping msg = build_notification("textDocument/didOpen");
  assert_equal("2.0", msg["jsonrpc"]);
  assert_equal("textDocument/didOpen", msg["method"]);
}

void test_build_notification_with_params() {
  // Params are included when supplied.
  mapping params = (["textDocument": (["uri": "file:///a.pike"])]);
  mapping msg = build_notification("textDocument/didChange", params);
  assert_not_null(msg["params"]);
  assert_equal("file:///a.pike", msg["params"]["textDocument"]["uri"]);
}

void test_build_notification_has_no_id_field() {
  // Notifications must not carry an id — this distinguishes them from requests.
  mapping msg = build_notification("initialized");
  assert_true(!has_index(msg, "id"));
}

void test_build_notification_without_params_omits_key() {
  // Omitting params should not inject a null key.
  mapping msg = build_notification("exit");
  assert_true(!has_index(msg, "params"));
}

// ---------------------------------------------------------------------------
// 3. Response building — build_response(id, result)
// ---------------------------------------------------------------------------

void test_build_response_success_fields() {
  // A success response contains jsonrpc, id, and result.
  mapping msg = build_response(1, (["capabilities": ([])]));
  assert_equal("2.0", msg["jsonrpc"]);
  assert_equal(1, msg["id"]);
  assert_not_null(msg["result"]);
  assert_true(has_index(msg["result"], "capabilities"));
}

void test_build_response_jsonrpc_version_is_2_0() {
  // Every response must declare protocol version 2.0 exactly.
  // Pike has no null literal — 0 is the zero value and is valid as a result.
  mapping msg = build_response(99, 0);
  assert_equal("2.0", msg["jsonrpc"]);
}

// ---------------------------------------------------------------------------
// 4. Error building — build_error(id, code, message, data)
// ---------------------------------------------------------------------------

void test_build_error_basic_fields() {
  // An error response contains jsonrpc, id, and an error mapping with code+message.
  mapping msg = build_error(1, -32600, "Invalid Request");
  assert_equal("2.0", msg["jsonrpc"]);
  assert_equal(1, msg["id"]);
  assert_not_null(msg["error"]);
  assert_equal(-32600, msg["error"]["code"]);
  assert_equal("Invalid Request", msg["error"]["message"]);
}

void test_build_error_with_data() {
  // Optional data field should appear when supplied.
  mapping msg = build_error(2, -32602, "Invalid params", (["detail": "extra"]));
  assert_not_null(msg["error"]["data"]);
  assert_equal("extra", msg["error"]["data"]["detail"]);
}

void test_build_error_mapping_has_code_and_message() {
  // The nested error mapping must always contain both code and message keys.
  mapping msg = build_error(5, -32601, "Method not found");
  assert_true(has_index(msg["error"], "code"));
  assert_true(has_index(msg["error"], "message"));
}

void test_build_error_without_data_omits_key() {
  // When data is not supplied the error mapping should not contain a "data" key.
  mapping msg = build_error(3, -32700, "Parse error");
  assert_true(!has_index(msg["error"], "data"));
}

// ---------------------------------------------------------------------------
// 5. Request validation — validate_request(msg)
// ---------------------------------------------------------------------------

void test_validate_request_valid_passes() {
  // A well-formed request should return 0 (no error).
  mapping msg = build_request(1, "initialize", (["rootUri": "file:///tmp"]));
  assert_null(validate_request(msg));
}

void test_validate_request_missing_jsonrpc_fails() {
  // Omitting the jsonrpc field must be rejected.
  mapping msg = (["id": 1, "method": "initialize"]);
  assert_not_null(validate_request(msg));
}

void test_validate_request_wrong_jsonrpc_version_fails() {
  // A version other than "2.0" must be rejected.
  mapping msg = (["jsonrpc": "1.0", "id": 1, "method": "initialize"]);
  assert_not_null(validate_request(msg));
}

void test_validate_request_missing_id_fails() {
  // A request without an id is not a request (it would be a notification).
  mapping msg = (["jsonrpc": "2.0", "method": "initialize"]);
  assert_not_null(validate_request(msg));
}

void test_validate_request_missing_method_fails() {
  // Every request must name the method being invoked.
  mapping msg = (["jsonrpc": "2.0", "id": 1]);
  assert_not_null(validate_request(msg));
}

void test_validate_request_non_string_method_fails() {
  // The method field must be a string per the spec.
  mapping msg = (["jsonrpc": "2.0", "id": 1, "method": 42]);
  assert_not_null(validate_request(msg));
}

void test_validate_request_non_mapping_params_fails() {
  // If params is present it must be a mapping (or array); non-mapping is invalid.
  mapping msg = (["jsonrpc": "2.0", "id": 1, "method": "foo", "params": "bad"]);
  assert_not_null(validate_request(msg));
}

void test_validate_request_null_message_fails() {
  // Passing 0 (not a mapping) must produce an error, not crash.
  assert_not_null(validate_request(0));
}

// ---------------------------------------------------------------------------
// 6. Notification validation — validate_notification(msg)
// ---------------------------------------------------------------------------

void test_validate_notification_valid_passes() {
  // A well-formed notification should return 0.
  mapping msg = build_notification("initialized");
  assert_null(validate_notification(msg));
}

void test_validate_notification_with_id_fails() {
  // Notifications must not carry an id — if present, validation must fail.
  mapping msg = (["jsonrpc": "2.0", "method": "initialized", "id": 1]);
  assert_not_null(validate_notification(msg));
}

void test_validate_notification_missing_method_fails() {
  // A notification without a method is meaningless.
  mapping msg = (["jsonrpc": "2.0"]);
  assert_not_null(validate_notification(msg));
}

void test_validate_notification_null_message_fails() {
  // Passing 0 should not crash the validator.
  assert_not_null(validate_notification(0));
}

// ---------------------------------------------------------------------------
// 7. Response validation — validate_response(msg)
// ---------------------------------------------------------------------------

void test_validate_response_success_passes() {
  // A valid success response (has result, no error) should pass.
  mapping msg = build_response(1, (["status": "ok"]));
  assert_null(validate_response(msg));
}

void test_validate_response_error_passes() {
  // A valid error response (has error, no result) should pass.
  mapping msg = build_error(1, -32600, "Invalid Request");
  assert_null(validate_response(msg));
}

void test_validate_response_both_result_and_error_fails() {
  // A response must not carry both result and error simultaneously.
  mapping msg = ([
    "jsonrpc": "2.0",
    "id": 1,
    "result": (["status": "ok"]),
    "error": (["code": -32600, "message": "Invalid"]),
  ]);
  assert_not_null(validate_response(msg));
}

void test_validate_response_neither_result_nor_error_fails() {
  // A response with neither result nor error is incomplete.
  mapping msg = (["jsonrpc": "2.0", "id": 1]);
  assert_not_null(validate_response(msg));
}

void test_validate_response_error_without_code_fails() {
  // The error mapping must contain a code field.
  mapping msg = ([
    "jsonrpc": "2.0",
    "id": 1,
    "error": (["message": "Something went wrong"]),
  ]);
  assert_not_null(validate_response(msg));
}

void test_validate_response_error_without_message_fails() {
  // The error mapping must contain a message field.
  mapping msg = ([
    "jsonrpc": "2.0",
    "id": 1,
    "error": (["code": -32600]),
  ]);
  assert_not_null(validate_response(msg));
}

void test_validate_response_null_message_fails() {
  // Passing 0 must produce an error, not crash.
  assert_not_null(validate_response(0));
}

// ---------------------------------------------------------------------------
// 8. Serialization roundtrip — encode_message / decode_message / decode_message_safe
// ---------------------------------------------------------------------------

void test_encode_decode_request_roundtrip() {
  // Encoding then decoding a request must preserve all fields.
  mapping original = build_request(10, "textDocument/hover", (["line": 5]));
  string json = encode_message(original);
  mapping decoded = decode_message(json);
  assert_not_null(decoded);
  assert_equal("2.0", decoded["jsonrpc"]);
  assert_equal(10, decoded["id"]);
  assert_equal("textDocument/hover", decoded["method"]);
  assert_equal(5, decoded["params"]["line"]);
}

void test_encode_decode_response_roundtrip() {
  // Encoding then decoding a response must preserve the result payload.
  mapping original = build_response(20, (["items": ({1, 2, 3})]));
  string json = encode_message(original);
  mapping decoded = decode_message(json);
  assert_not_null(decoded);
  assert_equal(20, decoded["id"]);
  assert_equal(3, sizeof(decoded["result"]["items"]));
}

void test_encode_decode_notification_roundtrip() {
  // Encoding then decoding a notification must preserve fields and lack of id.
  mapping original = build_notification("textDocument/didOpen",
    (["uri": "file:///test.pike"]));
  string json = encode_message(original);
  mapping decoded = decode_message(json);
  assert_not_null(decoded);
  assert_equal("textDocument/didOpen", decoded["method"]);
  assert_true(!has_index(decoded, "id"));
  assert_equal("file:///test.pike", decoded["params"]["uri"]);
}

void test_decode_invalid_json_returns_zero() {
  // Malformed JSON must return 0, not throw.
  mapping result = decode_message("{not valid json!!!");
  assert_null(result);
}

void test_decode_message_safe_returns_error_tuple_on_invalid_json() {
  // decode_message_safe must return ({error_string, 0}) for bad input.
  array result = decode_message_safe("<<<not json>>>");
  assert_not_null(result);
  assert_equal(2, sizeof(result));
  // First element is the error string, second is 0 (no mapping).
  assert_not_null(result[0]);
  assert_null(result[1]);
}

void test_decode_message_safe_returns_success_tuple_on_valid_json() {
  // decode_message_safe must return ({0, mapping}) for valid JSON.
  string json = Standards.JSON.encode((["jsonrpc": "2.0", "id": 1]));
  array result = decode_message_safe(json);
  assert_not_null(result);
  assert_equal(2, sizeof(result));
  // First element is 0 (no error), second is the decoded mapping.
  assert_null(result[0]);
  assert_not_null(result[1]);
  assert_equal(1, result[1]["id"]);
}

// ---------------------------------------------------------------------------
// 9. Error code constants — verify spec values
// ---------------------------------------------------------------------------

void test_error_constants_parse_error() {
  // JSON-RPC spec: Parse error is -32700.
  assert_equal(-32700, PARSE_ERROR);
}

void test_error_constants_invalid_request() {
  // JSON-RPC spec: Invalid Request is -32600.
  assert_equal(-32600, INVALID_REQUEST);
}

void test_error_constants_method_not_found() {
  // JSON-RPC spec: Method not found is -32601.
  assert_equal(-32601, METHOD_NOT_FOUND);
}

void test_error_constants_invalid_params() {
  // JSON-RPC spec: Invalid params is -32602.
  assert_equal(-32602, INVALID_PARAMS);
}

void test_error_constants_internal_error() {
  // JSON-RPC spec: Internal error is -32603.
  assert_equal(-32603, INTERNAL_ERROR);
}

void test_error_constants_are_negative_and_ordered() {
  // All standard error codes must be negative.  PARSE_ERROR (-32700) is in
  // a separate range from the -326xx group.  Within the -326xx group, codes
  // are assigned in descending order: -32600, -32601, -32602, -32603.
  assert_true(PARSE_ERROR < INVALID_REQUEST);
  assert_true(INVALID_REQUEST > METHOD_NOT_FOUND);
  assert_true(METHOD_NOT_FOUND > INVALID_PARAMS);
  assert_true(INVALID_PARAMS > INTERNAL_ERROR);
  // Verify all are negative.
  assert_true(PARSE_ERROR < 0);
  assert_true(INTERNAL_ERROR < 0);
}
