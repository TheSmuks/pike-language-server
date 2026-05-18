//! LspDocumentTests.pike — Unit tests for LSP textDocument notification structures.
//!
//! Goal: Verify that every textDocument notification — didOpen, didChange (full
//! and incremental), didClose, and didSave — can be built, validated, serialized,
//! and deserialized correctly using the LspProtocol.pmod module. These are the
//! messages that keep the server's document model in sync with the client, so
//! correctness here prevents stale-content and data-loss bugs.
//!
//! Methodology: Each test targets a single behavior — builders produce mappings
//! with the correct keys and values, validators accept valid messages and reject
//! specific invalid mutations, serializers round-trip without data loss, and
//! helper builders (Position, Range) produce spec-compliant structures.  Positive
//! and negative spaces are both exercised so boundary bugs are caught early.
//! A version-sequence test confirms the monotonically-increasing invariant that
//! the LSP spec requires across the lifetime of an open document.

import PUnit;
import LspProtocol;

inherit PUnit.TestCase;

// ---------------------------------------------------------------------------
// Shared constants — keeps URIs and sample text consistent across tests so
// that a reader can diff any two tests without noise from unrelated changes.
// ---------------------------------------------------------------------------

private constant DOC_URI = "file:///home/user/project/src/main.pike";
private constant DOC_LANGUAGE_ID = "pike";
private constant DOC_TEXT = "int main() { return 0; }\n";
private constant DOC_TEXT_V2 = "int main() { return 1; }\n";
private constant DOC_TEXT_V3 = "int main() { write(\"hello\\n\"); return 0; }\n";

// ===========================================================================
// 1. didOpen notification — textDocument/didOpen
// ===========================================================================

void test_did_open_params_contains_all_required_fields() {
  // didOpen params must carry a textDocument submapping with uri, languageId,
  // version, and text.  The server needs all four to initialize its document
  // model.
  mapping params = build_did_open_params(DOC_URI, DOC_LANGUAGE_ID, 1, DOC_TEXT);
  assert_not_null(params["textDocument"]);
  assert_equal(DOC_URI, params["textDocument"]["uri"]);
  assert_equal(DOC_LANGUAGE_ID, params["textDocument"]["languageId"]);
  assert_equal(1, params["textDocument"]["version"]);
  assert_equal(DOC_TEXT, params["textDocument"]["text"]);
}

void test_did_open_params_version_starts_at_zero() {
  // LSP allows the initial version to be 0.  Some clients start at 0, others
  // at 1 — both are valid, so the builder must accept 0.
  mapping params = build_did_open_params(DOC_URI, DOC_LANGUAGE_ID, 0, "");
  assert_equal(0, params["textDocument"]["version"]);
}

void test_did_open_params_version_starts_at_one() {
  // Starting at 1 is equally valid and more common in practice.
  mapping params = build_did_open_params(DOC_URI, DOC_LANGUAGE_ID, 1, "");
  assert_equal(1, params["textDocument"]["version"]);
}

void test_did_open_params_validates_successfully() {
  // A correctly-built didOpen params mapping must pass validation.
  mapping params = build_did_open_params(DOC_URI, DOC_LANGUAGE_ID, 1, DOC_TEXT);
  assert_null(validate_did_open_params(params));
}

void test_did_open_notification_is_valid_notification() {
  // Wrapping didOpen params in build_notification must produce a valid
  // JSON-RPC 2.0 notification (jsonrpc, method, no id).
  mapping params = build_did_open_params(DOC_URI, DOC_LANGUAGE_ID, 1, DOC_TEXT);
  mapping msg = build_notification("textDocument/didOpen", params);

  assert_equal("2.0", msg["jsonrpc"]);
  assert_equal("textDocument/didOpen", msg["method"]);
  // Notifications never carry an id.
  assert_true(!has_index(msg, "id"));
}

void test_did_open_notification_validates_as_notification() {
  // The full didOpen notification must pass notification-level validation.
  mapping params = build_did_open_params(DOC_URI, DOC_LANGUAGE_ID, 1, DOC_TEXT);
  mapping msg = build_notification("textDocument/didOpen", params);
  assert_null(validate_notification(msg));
}

void test_did_open_notification_roundtrip() {
  // Encode/decode must preserve the nested textDocument structure including
  // the full document text — any data loss would desync the server's model.
  mapping params = build_did_open_params(DOC_URI, DOC_LANGUAGE_ID, 1, DOC_TEXT);
  mapping original = build_notification("textDocument/didOpen", params);
  string json = encode_message(original);
  mapping decoded = decode_message(json);

  assert_not_null(decoded);
  assert_equal("textDocument/didOpen", decoded["method"]);
  assert_equal("2.0", decoded["jsonrpc"]);
  assert_true(!has_index(decoded, "id"));
  assert_equal(DOC_URI, decoded["params"]["textDocument"]["uri"]);
  assert_equal(DOC_LANGUAGE_ID, decoded["params"]["textDocument"]["languageId"]);
  assert_equal(1, decoded["params"]["textDocument"]["version"]);
  assert_equal(DOC_TEXT, decoded["params"]["textDocument"]["text"]);
}

// ===========================================================================
// 2. didChange full sync — textDocument/didChange (full document content)
// ===========================================================================

void test_did_change_full_params_contains_textDocument_and_contentChanges() {
  // Full-sync didChange params must carry a textDocument submapping (uri +
  // version) and a contentChanges array with exactly one element whose text
  // is the entire new document content.
  mapping params = build_did_change_full_params(DOC_URI, 2, DOC_TEXT_V2);
  assert_not_null(params["textDocument"]);
  assert_equal(DOC_URI, params["textDocument"]["uri"]);
  assert_equal(2, params["textDocument"]["version"]);
  assert_not_null(params["contentChanges"]);
  assert_true(arrayp(params["contentChanges"]));
  assert_equal(1, sizeof(params["contentChanges"]));
  assert_equal(DOC_TEXT_V2, params["contentChanges"][0]["text"]);
}

void test_did_change_full_params_has_no_range() {
  // Full sync does not include a range — the entire document is replaced.
  // The absence of range distinguishes full from incremental sync.
  mapping params = build_did_change_full_params(DOC_URI, 2, DOC_TEXT_V2);
  assert_true(!has_index(params["contentChanges"][0], "range"));
}

void test_did_change_full_params_validates_successfully() {
  // A correctly-built full-sync didChange must pass validation.
  mapping params = build_did_change_full_params(DOC_URI, 2, DOC_TEXT_V2);
  assert_null(validate_did_change_params(params));
}

void test_did_change_full_notification_is_valid() {
  // The full notification wrapping must be a valid JSON-RPC notification.
  mapping params = build_did_change_full_params(DOC_URI, 2, DOC_TEXT_V2);
  mapping msg = build_notification("textDocument/didChange", params);
  assert_null(validate_notification(msg));
}

void test_did_change_full_notification_roundtrip() {
  // Roundtrip must preserve the contentChanges array and its text element.
  mapping params = build_did_change_full_params(DOC_URI, 2, DOC_TEXT_V2);
  mapping original = build_notification("textDocument/didChange", params);
  string json = encode_message(original);
  mapping decoded = decode_message(json);

  assert_not_null(decoded);
  assert_equal("textDocument/didChange", decoded["method"]);
  assert_equal(DOC_URI, decoded["params"]["textDocument"]["uri"]);
  assert_equal(2, decoded["params"]["textDocument"]["version"]);
  assert_equal(1, sizeof(decoded["params"]["contentChanges"]));
  assert_equal(DOC_TEXT_V2, decoded["params"]["contentChanges"][0]["text"]);
  // Range must still be absent after roundtrip.
  assert_true(!has_index(decoded["params"]["contentChanges"][0], "range"));
}

// ===========================================================================
// 3. didChange incremental sync — textDocument/didChange (with range)
// ===========================================================================

void test_did_change_incremental_params_has_range_and_text() {
  // Incremental sync replaces a specific range with new text.  The
  // contentChanges element must carry both range and text.
  mapping start = build_position(0, 4);
  mapping end = build_position(0, 8);
  mapping range = build_range(start, end);
  mapping params = build_did_change_incremental_params(
    DOC_URI, 3, range, "float"
  );

  assert_not_null(params["textDocument"]);
  assert_equal(DOC_URI, params["textDocument"]["uri"]);
  assert_equal(3, params["textDocument"]["version"]);
  assert_not_null(params["contentChanges"]);
  assert_equal(1, sizeof(params["contentChanges"]));

  mapping change = params["contentChanges"][0];
  assert_equal("float", change["text"]);
  assert_not_null(change["range"]);
}

void test_did_change_incremental_params_range_has_start_and_end() {
  // The range inside contentChanges must carry start and end positions, each
  // with line and character fields.
  mapping start = build_position(2, 10);
  mapping end = build_position(2, 14);
  mapping range = build_range(start, end);
  mapping params = build_did_change_incremental_params(
    DOC_URI, 4, range, "test"
  );

  mapping decoded_range = params["contentChanges"][0]["range"];
  assert_equal(2, decoded_range["start"]["line"]);
  assert_equal(10, decoded_range["start"]["character"]);
  assert_equal(2, decoded_range["end"]["line"]);
  assert_equal(14, decoded_range["end"]["character"]);
}

void test_did_change_incremental_params_validates_successfully() {
  // A correctly-built incremental didChange must pass validation.
  mapping start = build_position(0, 0);
  mapping end = build_position(0, 3);
  mapping range = build_range(start, end);
  mapping params = build_did_change_incremental_params(
    DOC_URI, 2, range, "int"
  );
  assert_null(validate_did_change_params(params));
}

void test_did_change_incremental_notification_validates() {
  // The full notification must pass notification-level validation.
  mapping range = build_range(build_position(0, 0), build_position(0, 3));
  mapping params = build_did_change_incremental_params(
    DOC_URI, 2, range, "int"
  );
  mapping msg = build_notification("textDocument/didChange", params);
  assert_null(validate_notification(msg));
}

void test_did_change_incremental_notification_roundtrip() {
  // Roundtrip must preserve the range structure inside contentChanges.
  // A bug here would cause the server to apply edits at wrong positions.
  mapping start = build_position(5, 12);
  mapping end = build_position(5, 16);
  mapping range = build_range(start, end);
  mapping params = build_did_change_incremental_params(
    DOC_URI, 6, range, "long"
  );
  mapping original = build_notification("textDocument/didChange", params);
  string json = encode_message(original);
  mapping decoded = decode_message(json);

  assert_not_null(decoded);
  assert_equal("textDocument/didChange", decoded["method"]);
  assert_equal(DOC_URI, decoded["params"]["textDocument"]["uri"]);
  assert_equal(6, decoded["params"]["textDocument"]["version"]);

  mapping change = decoded["params"]["contentChanges"][0];
  assert_equal("long", change["text"]);
  assert_equal(5, change["range"]["start"]["line"]);
  assert_equal(12, change["range"]["start"]["character"]);
  assert_equal(5, change["range"]["end"]["line"]);
  assert_equal(16, change["range"]["end"]["character"]);
}

// ===========================================================================
// 4. didClose notification — textDocument/didClose
// ===========================================================================

void test_did_close_params_contains_only_uri() {
  // didClose params need only a textDocument submapping with the uri.
  // No text, version, or languageId — the document is being released.
  mapping params = build_did_close_params(DOC_URI);
  assert_not_null(params["textDocument"]);
  assert_equal(DOC_URI, params["textDocument"]["uri"]);
}

void test_did_close_params_has_no_text_field() {
  // Closing a document does not transmit content — only the identifier.
  mapping params = build_did_close_params(DOC_URI);
  assert_true(!has_index(params["textDocument"], "text"));
}

void test_did_close_params_has_no_version_field() {
  // Version is meaningless at close time; the server just releases resources.
  mapping params = build_did_close_params(DOC_URI);
  assert_true(!has_index(params["textDocument"], "version"));
}

void test_did_close_params_validates_successfully() {
  // A correctly-built didClose params must pass validation.
  mapping params = build_did_close_params(DOC_URI);
  assert_null(validate_did_close_params(params));
}

void test_did_close_notification_is_valid_notification() {
  // The full didClose notification must be a valid JSON-RPC notification.
  mapping params = build_did_close_params(DOC_URI);
  mapping msg = build_notification("textDocument/didClose", params);

  assert_equal("2.0", msg["jsonrpc"]);
  assert_equal("textDocument/didClose", msg["method"]);
  assert_true(!has_index(msg, "id"));
  assert_null(validate_notification(msg));
}

void test_did_close_notification_roundtrip() {
  // Roundtrip must preserve the uri inside textDocument.
  mapping params = build_did_close_params(DOC_URI);
  mapping original = build_notification("textDocument/didClose", params);
  string json = encode_message(original);
  mapping decoded = decode_message(json);

  assert_not_null(decoded);
  assert_equal("textDocument/didClose", decoded["method"]);
  assert_equal(DOC_URI, decoded["params"]["textDocument"]["uri"]);
  // No id after roundtrip.
  assert_true(!has_index(decoded, "id"));
}

// ===========================================================================
// 5. didSave notification — textDocument/didSave
// ===========================================================================

void test_did_save_params_without_text() {
  // didSave can be sent without the document text (includeText was false or
  // not requested).  Only the uri is required.
  mapping params = build_did_save_params(DOC_URI, 0);
  assert_not_null(params["textDocument"]);
  assert_equal(DOC_URI, params["textDocument"]["uri"]);
}

void test_did_save_params_with_text() {
  // When includeText is true, the server receives the full document content
  // alongside the uri.  This lets the server re-sync without re-parsing.
  mapping params = build_did_save_params(DOC_URI, DOC_TEXT);
  assert_not_null(params["textDocument"]);
  assert_equal(DOC_URI, params["textDocument"]["uri"]);
  assert_equal(DOC_TEXT, params["text"]);
}

void test_did_save_notification_without_text_is_valid() {
  // A didSave without text must still be a valid notification.
  mapping params = build_did_save_params(DOC_URI, 0);
  mapping msg = build_notification("textDocument/didSave", params);
  assert_null(validate_notification(msg));
}

void test_did_save_notification_with_text_is_valid() {
  // A didSave with text must also be a valid notification.
  mapping params = build_did_save_params(DOC_URI, DOC_TEXT);
  mapping msg = build_notification("textDocument/didSave", params);
  assert_null(validate_notification(msg));
}

void test_did_save_notification_roundtrip_without_text() {
  // Roundtrip without text must preserve the uri and omit text.
  mapping params = build_did_save_params(DOC_URI, 0);
  mapping original = build_notification("textDocument/didSave", params);
  string json = encode_message(original);
  mapping decoded = decode_message(json);

  assert_not_null(decoded);
  assert_equal("textDocument/didSave", decoded["method"]);
  assert_equal(DOC_URI, decoded["params"]["textDocument"]["uri"]);
}

void test_did_save_notification_roundtrip_with_text() {
  // Roundtrip with text must preserve both uri and document content.
  mapping params = build_did_save_params(DOC_URI, DOC_TEXT);
  mapping original = build_notification("textDocument/didSave", params);
  string json = encode_message(original);
  mapping decoded = decode_message(json);

  assert_not_null(decoded);
  assert_equal("textDocument/didSave", decoded["method"]);
  assert_equal(DOC_URI, decoded["params"]["textDocument"]["uri"]);
  assert_equal(DOC_TEXT, decoded["params"]["text"]);
}

// ===========================================================================
// 6. Position helper — build_position / validate_position
// ===========================================================================

void test_position_builds_with_valid_values() {
  // A position at line 5, character 12 must produce a mapping with those
  // exact values.
  mapping pos = build_position(5, 12);
  assert_equal(5, pos["line"]);
  assert_equal(12, pos["character"]);
}

void test_position_validates_successfully() {
  // A well-formed position must pass validation.
  mapping pos = build_position(5, 12);
  assert_null(validate_position(pos));
}

void test_position_at_origin_validates() {
  // The origin position (0, 0) is valid — it represents the start of the
  // document.  Both zero-indexed fields are non-negative.
  mapping pos = build_position(0, 0);
  assert_equal(0, pos["line"]);
  assert_equal(0, pos["character"]);
  assert_null(validate_position(pos));
}

void test_position_with_large_values_validates() {
  // Large line/character numbers are valid (e.g., large files).
  mapping pos = build_position(99999, 99999);
  assert_null(validate_position(pos));
}

void test_position_negative_line_fails_validation() {
  // Negative line numbers are illegal — lines are zero-indexed upward.
  mapping pos = (["line": -1, "character": 0]);
  assert_not_null(validate_position(pos));
}

void test_position_negative_character_fails_validation() {
  // Negative character positions are illegal.
  mapping pos = (["line": 0, "character": -1]);
  assert_not_null(validate_position(pos));
}

void test_position_missing_line_fails_validation() {
  // A position without a line field is incomplete.
  mapping pos = (["character": 5]);
  assert_not_null(validate_position(pos));
}

void test_position_missing_character_fails_validation() {
  // A position without a character field is incomplete.
  mapping pos = (["line": 5]);
  assert_not_null(validate_position(pos));
}

void test_position_null_fails_validation() {
  // Passing 0 (not a mapping) must produce an error, not crash.
  assert_not_null(validate_position(0));
}

// ===========================================================================
// 7. Range helper — build_range / validate_range
// ===========================================================================

void test_range_builds_with_positions() {
  // A range from (1, 0) to (1, 10) must carry start and end submappings.
  mapping start = build_position(1, 0);
  mapping end = build_position(1, 10);
  mapping range = build_range(start, end);

  assert_not_null(range["start"]);
  assert_not_null(range["end"]);
  assert_equal(1, range["start"]["line"]);
  assert_equal(0, range["start"]["character"]);
  assert_equal(1, range["end"]["line"]);
  assert_equal(10, range["end"]["character"]);
}

void test_range_validates_successfully() {
  // A well-formed range with valid start and end must pass validation.
  mapping start = build_position(0, 5);
  mapping end = build_position(0, 10);
  mapping range = build_range(start, end);
  assert_null(validate_range(range));
}

void test_range_single_character_start_equals_end() {
  // A range where start == end represents a cursor position (zero-length
  // selection).  This is valid per the LSP spec.
  mapping pos = build_position(3, 7);
  mapping range = build_range(pos, pos);

  assert_equal(3, range["start"]["line"]);
  assert_equal(7, range["start"]["character"]);
  assert_equal(range["start"]["line"], range["end"]["line"]);
  assert_equal(range["start"]["character"], range["end"]["character"]);
  assert_null(validate_range(range));
}

void test_range_multi_line_validates() {
  // A range spanning multiple lines is valid (e.g., selecting a block).
  mapping start = build_position(2, 0);
  mapping end = build_position(5, 20);
  mapping range = build_range(start, end);

  assert_true(range["end"]["line"] > range["start"]["line"]);
  assert_null(validate_range(range));
}

void test_range_invalid_start_fails_validation() {
  // If the start position is invalid, the entire range is invalid.
  mapping start = (["line": -1, "character": 0]);  // Invalid: negative line.
  mapping end = build_position(0, 10);
  mapping range = (["start": start, "end": end]);
  assert_not_null(validate_range(range));
}

void test_range_invalid_end_fails_validation() {
  // If the end position is invalid, the entire range is invalid.
  mapping start = build_position(0, 0);
  mapping end = (["line": 0, "character": -5]);  // Invalid: negative character.
  mapping range = (["start": start, "end": end]);
  assert_not_null(validate_range(range));
}

void test_range_null_fails_validation() {
  // Passing 0 (not a mapping) must produce an error, not crash.
  assert_not_null(validate_range(0));
}

// ===========================================================================
// 8. Document version sequence — didOpen → didChange → didChange → didClose
//    Verifies the monotonically-increasing version invariant.
// ===========================================================================

void test_version_sequence_all_messages_validate() {
  // Build a realistic document lifecycle: open at v1, change to v2, change
  // to v3, close.  Every message in the sequence must pass its validator.
  mapping open_params = build_did_open_params(DOC_URI, DOC_LANGUAGE_ID, 1, DOC_TEXT);
  mapping change_v2_params = build_did_change_full_params(DOC_URI, 2, DOC_TEXT_V2);
  mapping change_v3_params = build_did_change_full_params(DOC_URI, 3, DOC_TEXT_V3);
  mapping close_params = build_did_close_params(DOC_URI);

  assert_null(validate_did_open_params(open_params));
  assert_null(validate_did_change_params(change_v2_params));
  assert_null(validate_did_change_params(change_v3_params));
  assert_null(validate_did_close_params(close_params));
}

void test_version_sequence_all_notifications_validate() {
  // Wrapping each params in a notification must produce valid notifications.
  mapping open_notif = build_notification("textDocument/didOpen",
    build_did_open_params(DOC_URI, DOC_LANGUAGE_ID, 1, DOC_TEXT));
  mapping change_v2_notif = build_notification("textDocument/didChange",
    build_did_change_full_params(DOC_URI, 2, DOC_TEXT_V2));
  mapping change_v3_notif = build_notification("textDocument/didChange",
    build_did_change_full_params(DOC_URI, 3, DOC_TEXT_V3));
  mapping close_notif = build_notification("textDocument/didClose",
    build_did_close_params(DOC_URI));

  assert_null(validate_notification(open_notif));
  assert_null(validate_notification(change_v2_notif));
  assert_null(validate_notification(change_v3_notif));
  assert_null(validate_notification(close_notif));
}

void test_version_sequence_versions_are_monotonically_increasing() {
  // The LSP spec requires that document versions increase strictly over the
  // lifetime of an open document.  If versions go backward or stay flat, the
  // server would apply stale edits.
  mapping open_params = build_did_open_params(DOC_URI, DOC_LANGUAGE_ID, 1, DOC_TEXT);
  mapping change_v2_params = build_did_change_full_params(DOC_URI, 2, DOC_TEXT_V2);
  mapping change_v3_params = build_did_change_full_params(DOC_URI, 3, DOC_TEXT_V3);

  int v_open = open_params["textDocument"]["version"];
  int v_change1 = change_v2_params["textDocument"]["version"];
  int v_change2 = change_v3_params["textDocument"]["version"];

  assert_true(v_open < v_change1);
  assert_true(v_change1 < v_change2);
}

void test_version_sequence_roundtrip_preserves_ordering() {
  // After roundtripping every notification through encode/decode, the version
  // ordering must still hold.  This catches serialization bugs that mangle
  // integers (e.g., converting them to strings).
  mapping open_notif = build_notification("textDocument/didOpen",
    build_did_open_params(DOC_URI, DOC_LANGUAGE_ID, 1, DOC_TEXT));
  mapping change_v2_notif = build_notification("textDocument/didChange",
    build_did_change_full_params(DOC_URI, 2, DOC_TEXT_V2));
  mapping change_v3_notif = build_notification("textDocument/didChange",
    build_did_change_full_params(DOC_URI, 3, DOC_TEXT_V3));

  mapping d_open = decode_message(encode_message(open_notif));
  mapping d_change_v2 = decode_message(encode_message(change_v2_notif));
  mapping d_change_v3 = decode_message(encode_message(change_v3_notif));

  assert_true(d_open["params"]["textDocument"]["version"]
    < d_change_v2["params"]["textDocument"]["version"]);
  assert_true(d_change_v2["params"]["textDocument"]["version"]
    < d_change_v3["params"]["textDocument"]["version"]);
}

void test_version_sequence_starting_at_zero() {
  // Some clients start version numbering at 0.  The sequence 0 → 1 → 2 must
  // also validate and maintain monotonic ordering.
  mapping open_params = build_did_open_params(DOC_URI, DOC_LANGUAGE_ID, 0, "");
  mapping change_v1_params = build_did_change_full_params(DOC_URI, 1, "x");
  mapping change_v2_params = build_did_change_full_params(DOC_URI, 2, "xy");

  assert_null(validate_did_open_params(open_params));
  assert_null(validate_did_change_params(change_v1_params));
  assert_null(validate_did_change_params(change_v2_params));

  assert_true(open_params["textDocument"]["version"]
    < change_v1_params["textDocument"]["version"]);
  assert_true(change_v1_params["textDocument"]["version"]
    < change_v2_params["textDocument"]["version"]);
}
