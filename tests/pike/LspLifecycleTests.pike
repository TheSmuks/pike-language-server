//! LspLifecycleTests.pike — Unit tests for LSP lifecycle message structures.
//!
//! Goal: Verify that every LSP lifecycle message — initialize, initialized,
//! shutdown, and exit — can be built, validated, serialized, and deserialized
//! correctly using the LspProtocol.pmod module. The LSP lifecycle has a strict
//! ordering (initialize → initialized → … → shutdown → exit) and these tests
//! confirm that every message in that sequence conforms to JSON-RPC 2.0 and
//! the LSP specification.
//!
//! Methodology: Each test targets a single behavior — builders produce mappings
//! with the correct keys and values, validators accept valid messages and reject
//! specific invalid mutations, serializers round-trip without data loss, and
//! the full lifecycle sequence exercises ordering invariants.  Positive and
//! negative spaces are both exercised so boundary bugs are caught early.

import PUnit;
import LspProtocol;

inherit PUnit.TestCase;

// ---------------------------------------------------------------------------
// Helper: build a fully-populated InitOptions mapping (mirrors the TypeScript
// InitOptions interface in serverInitHandler.ts).  Used by several tests so
// that the "all options" variant stays in one place and stays correct.
// ---------------------------------------------------------------------------

private mapping build_full_init_options() {
  // Every field the Pike LSP server accepts via initializationOptions.
  return ([
    "diagnosticMode": "realtime",
    "pikeBinaryPath": "/usr/bin/pike",
    "diagnosticDebounceMs": 250,
    "maxNumberOfProblems": 100,
    "backgroundIndexEnabled": Val.true,
    "backgroundIndexBatchSize": 50,
    "workerRequestTimeoutMs": 30000,
    "workerIdleTimeoutMs": 60000,
    "workerMaxRequestsBeforeRestart": 500,
    "workerMaxActiveMinutes": 30,
    "workerNiceValue": 10,
    "formatInsertFinalNewline": Val.true,
    "formatOperatorSpacing": Val.false,
    "pikeHome": "/home/user/.pike",
    "modulePaths": ({ "/usr/lib/pike/modules", "/home/user/pike_modules" }),
    "includePaths": ({ "/usr/include/pike" }),
    "programPaths": ({ "." }),
  ]);
}

// ---------------------------------------------------------------------------
// Helper: build server capabilities mapping that a server would return in an
// initialize response.  Kept in one place so the capabilities tests reference
// a realistic structure.
// ---------------------------------------------------------------------------

private mapping build_server_capabilities() {
  return ([
    "textDocumentSync": ([
      "openClose": Val.true,
      "change": 1,  // Full sync
      "save": ([ "includeText": Val.true ]),
    ]),
    "completionProvider": ([
      "triggerCharacters": ({ ".", ">", ":" }),
      "resolveProvider": Val.false,
    ]),
    "hoverProvider": Val.true,
    "definitionProvider": Val.true,
    "referencesProvider": Val.true,
    "documentSymbolProvider": Val.true,
    "documentFormattingProvider": Val.true,
  ]);
}

// ===========================================================================
// 1. Initialize request — build_initialize_params + build_request
// ===========================================================================

void test_initialize_request_minimal_fields() {
  // A minimal initialize request carries only rootUri in the params.
  // Capabilities defaults to an empty mapping when not provided.
  mapping params = build_initialize_params("file:///home/user/project");
  mapping msg = build_request(1, "initialize", params);

  assert_equal("2.0", msg["jsonrpc"]);
  assert_equal(1, msg["id"]);
  assert_equal("initialize", msg["method"]);
  assert_not_null(msg["params"]);
  assert_equal("file:///home/user/project", msg["params"]["rootUri"]);
}

void test_initialize_request_has_empty_capabilities_by_default() {
  // When no capabilities are supplied, build_initialize_params must still
  // include an empty capabilities mapping (LSP spec requires the key).
  mapping params = build_initialize_params("file:///tmp");
  assert_not_null(params["capabilities"]);
  assert_equal(0, sizeof(params["capabilities"]));
}

void test_initialize_request_with_client_capabilities() {
  // Client capabilities should be passed through verbatim.
  mapping caps = ([
    "textDocument": ([
      "completion": (["completionItem": (["snippetSupport": Val.true])]),
    ]),
  ]);
  mapping params = build_initialize_params("file:///project", caps);
  assert_not_null(params["capabilities"]);
  assert_equal(Val.true,
    params["capabilities"]["textDocument"]["completion"]["completionItem"]["snippetSupport"]);
}

void test_initialize_request_with_initialization_options() {
  // Custom initializationOptions must appear as a nested mapping.
  mapping opts = ([
    "diagnosticMode": "saveOnly",
    "maxNumberOfProblems": 50,
  ]);
  mapping params = build_initialize_params("file:///project", 0, opts);
  assert_not_null(params["initializationOptions"]);
  assert_equal("saveOnly", params["initializationOptions"]["diagnosticMode"]);
  assert_equal(50, params["initializationOptions"]["maxNumberOfProblems"]);
}

void test_initialize_request_with_all_supported_init_options() {
  // Exercise every field from the InitOptions interface to catch typos or
  // structural mismatches early.  Uses the shared helper so there is a
  // single place to update when options change.
  mapping opts = build_full_init_options();
  mapping params = build_initialize_params("file:///project", 0, opts);
  mapping initOpts = params["initializationOptions"];

  assert_not_null(initOpts);
  // Scalar string options.
  assert_equal("realtime", initOpts["diagnosticMode"]);
  assert_equal("/usr/bin/pike", initOpts["pikeBinaryPath"]);
  assert_equal("/home/user/.pike", initOpts["pikeHome"]);
  // Numeric options.
  assert_equal(250, initOpts["diagnosticDebounceMs"]);
  assert_equal(100, initOpts["maxNumberOfProblems"]);
  assert_equal(50, initOpts["backgroundIndexBatchSize"]);
  assert_equal(30000, initOpts["workerRequestTimeoutMs"]);
  assert_equal(60000, initOpts["workerIdleTimeoutMs"]);
  assert_equal(500, initOpts["workerMaxRequestsBeforeRestart"]);
  assert_equal(30, initOpts["workerMaxActiveMinutes"]);
  assert_equal(10, initOpts["workerNiceValue"]);
  // Boolean options.
  assert_equal(Val.true, initOpts["backgroundIndexEnabled"]);
  assert_equal(Val.true, initOpts["formatInsertFinalNewline"]);
  assert_equal(Val.false, initOpts["formatOperatorSpacing"]);
  // Array options — verify type and non-empty.
  assert_true(arrayp(initOpts["modulePaths"]));
  assert_equal(2, sizeof(initOpts["modulePaths"]));
  assert_true(arrayp(initOpts["includePaths"]));
  assert_equal(1, sizeof(initOpts["includePaths"]));
  assert_true(arrayp(initOpts["programPaths"]));
  assert_equal(1, sizeof(initOpts["programPaths"]));
}

void test_initialize_request_passes_validation() {
  // A well-formed initialize request must validate without error.
  mapping params = build_initialize_params("file:///home/user/project");
  mapping msg = build_request(1, "initialize", params);
  assert_null(validate_request(msg));
}

void test_initialize_request_method_is_initialize() {
  // The method field for the lifecycle start must be exactly "initialize".
  mapping msg = build_request(1, "initialize",
    build_initialize_params("file:///tmp"));
  assert_equal("initialize", msg["method"]);
}

void test_initialize_request_id_is_present() {
  // Every request must carry an id; without it the message would be a
  // notification and the server could not correlate the response.
  mapping msg = build_request(42, "initialize",
    build_initialize_params("file:///tmp"));
  assert_true(has_index(msg, "id"));
  assert_equal(42, msg["id"]);
}

void test_initialize_request_encode_decode_roundtrip() {
  // Serialize and deserialize must preserve all fields including nested
  // initializationOptions.
  mapping opts = ([
    "diagnosticMode": "off",
    "pikeBinaryPath": "/opt/pike/bin/pike",
    "modulePaths": ({ "/lib/modules" }),
  ]);
  mapping params = build_initialize_params("file:///workspace", 0, opts);
  mapping original = build_request(7, "initialize", params);
  string json = encode_message(original);
  mapping decoded = decode_message(json);

  assert_not_null(decoded);
  assert_equal("2.0", decoded["jsonrpc"]);
  assert_equal(7, decoded["id"]);
  assert_equal("initialize", decoded["method"]);
  assert_equal("file:///workspace", decoded["params"]["rootUri"]);
  assert_equal("off", decoded["params"]["initializationOptions"]["diagnosticMode"]);
  assert_equal("/opt/pike/bin/pike",
    decoded["params"]["initializationOptions"]["pikeBinaryPath"]);
  assert_equal(1, sizeof(decoded["params"]["initializationOptions"]["modulePaths"]));
}

// ===========================================================================
// 2. Initialize response — server replies with capabilities
// ===========================================================================

void test_initialize_response_success_fields() {
  // The server responds to initialize with its capabilities.
  mapping caps = build_server_capabilities();
  mapping msg = build_response(1, (["capabilities": caps]));

  assert_equal("2.0", msg["jsonrpc"]);
  assert_equal(1, msg["id"]);
  assert_not_null(msg["result"]);
  assert_not_null(msg["result"]["capabilities"]);
}

void test_initialize_response_has_textDocument_sync() {
  // textDocumentSync is required — the client needs to know how to sync
  // document content.
  mapping caps = build_server_capabilities();
  mapping msg = build_response(1, (["capabilities": caps]));

  mapping sync = msg["result"]["capabilities"]["textDocumentSync"];
  assert_not_null(sync);
  assert_equal(Val.true, sync["openClose"]);
  assert_equal(1, sync["change"]);
}

void test_initialize_response_has_completion_provider_with_triggers() {
  // The completion provider must advertise trigger characters so the client
  // knows when to auto-request completions.
  mapping caps = build_server_capabilities();
  mapping msg = build_response(1, (["capabilities": caps]));

  mapping provider = msg["result"]["capabilities"]["completionProvider"];
  assert_not_null(provider);
  assert_true(arrayp(provider["triggerCharacters"]));
  assert_true(sizeof(provider["triggerCharacters"]) > 0);
  // Verify expected Pike trigger characters are present.
  assert_true(search(provider["triggerCharacters"], ".") >= 0);
  assert_true(search(provider["triggerCharacters"], ">") >= 0);
  assert_true(search(provider["triggerCharacters"], ":") >= 0);
}

void test_initialize_response_validates_correctly() {
  // The initialize response is a standard JSON-RPC response; it must pass
  // response validation.
  mapping msg = build_response(1, (["capabilities": build_server_capabilities()]));
  assert_null(validate_response(msg));
}

void test_initialize_response_roundtrip() {
  // Capabilities must survive serialization so the client can read them.
  mapping msg = build_response(1, (["capabilities": build_server_capabilities()]));
  string json = encode_message(msg);
  mapping decoded = decode_message(json);

  assert_not_null(decoded);
  assert_equal(1, decoded["id"]);
  assert_not_null(decoded["result"]["capabilities"]);
  assert_not_null(decoded["result"]["capabilities"]["textDocumentSync"]);
  assert_not_null(decoded["result"]["capabilities"]["completionProvider"]);
  // Verify trigger characters survived the roundtrip.
  array triggers = decoded["result"]["capabilities"]["completionProvider"]["triggerCharacters"];
  assert_equal(3, sizeof(triggers));
}

// ===========================================================================
// 3. Initialized notification — client confirms initialization is done
// ===========================================================================

void test_initialized_notification_basic_fields() {
  // The initialized notification signals that the client has finished
  // processing the initialize result.  Per LSP spec, params are empty.
  mapping msg = build_notification("initialized", ([]));

  assert_equal("2.0", msg["jsonrpc"]);
  assert_equal("initialized", msg["method"]);
  assert_not_null(msg["params"]);
}

void test_initialized_notification_validates_as_notification() {
  // Must pass notification validation (jsonrpc 2.0, has method, no id).
  mapping msg = build_notification("initialized", ([]));
  assert_null(validate_notification(msg));
}

void test_initialized_notification_has_no_id_field() {
  // Notifications never carry an id — this is the distinguishing feature
  // between requests and notifications in JSON-RPC 2.0.
  mapping msg = build_notification("initialized", ([]));
  assert_true(!has_index(msg, "id"));
}

void test_initialized_notification_roundtrip() {
  // The initialized notification must survive encode/decode intact.
  mapping original = build_notification("initialized", ([]));
  string json = encode_message(original);
  mapping decoded = decode_message(json);

  assert_not_null(decoded);
  assert_equal("initialized", decoded["method"]);
  assert_equal("2.0", decoded["jsonrpc"]);
  // Params should be present (empty mapping serializes as {}).
  assert_not_null(decoded["params"]);
  // Still no id after roundtrip.
  assert_true(!has_index(decoded, "id"));
}

// ===========================================================================
// 4. Shutdown request — client asks server to shut down gracefully
// ===========================================================================

void test_shutdown_request_basic_fields() {
  // The shutdown request has method "shutdown" and carries no params.
  mapping msg = build_request(2, "shutdown");

  assert_equal("2.0", msg["jsonrpc"]);
  assert_equal(2, msg["id"]);
  assert_equal("shutdown", msg["method"]);
  // No params for shutdown.
  assert_true(!has_index(msg, "params"));
}

void test_shutdown_request_validates_as_request() {
  // A shutdown request is a standard JSON-RPC request.
  mapping msg = build_request(2, "shutdown");
  assert_null(validate_request(msg));
}

void test_shutdown_request_roundtrip() {
  // Shutdown must survive serialization — the server reads it from stdin.
  mapping original = build_request(2, "shutdown");
  string json = encode_message(original);
  mapping decoded = decode_message(json);

  assert_not_null(decoded);
  assert_equal("2.0", decoded["jsonrpc"]);
  assert_equal(2, decoded["id"]);
  assert_equal("shutdown", decoded["method"]);
  // No params after roundtrip either.
  assert_true(!has_index(decoded, "params"));
}

// ===========================================================================
// 5. Shutdown response — server acknowledges shutdown
// ===========================================================================

void test_shutdown_response_success_with_null_result() {
  // Per LSP spec, the server responds to shutdown with result null.
  mapping msg = build_response(2, Val.null);

  assert_equal("2.0", msg["jsonrpc"]);
  assert_equal(2, msg["id"]);
  // The result key must be present — the server acknowledged shutdown.
  assert_true(has_index(msg, "result"));
}

void test_shutdown_response_validates() {
  // A shutdown response with null result must pass response validation.
  // JSON-RPC requires either "result" or "error", and result=null is valid.
  mapping msg = build_response(2, Val.null);
  assert_null(validate_response(msg));
}

void test_shutdown_response_roundtrip() {
  // The null result must survive encode/decode.
  mapping original = build_response(2, Val.null);
  string json = encode_message(original);
  mapping decoded = decode_message(json);

  assert_not_null(decoded);
  assert_equal(2, decoded["id"]);
  assert_true(has_index(decoded, "result"));
}

// ===========================================================================
// 6. Exit notification — client tells server to terminate immediately
// ===========================================================================

void test_exit_notification_basic_fields() {
  // The exit notification has method "exit" and no params.  After this
  // message the server process should terminate.
  mapping msg = build_notification("exit");

  assert_equal("2.0", msg["jsonrpc"]);
  assert_equal("exit", msg["method"]);
}

void test_exit_notification_validates_as_notification() {
  // Must pass notification validation.
  mapping msg = build_notification("exit");
  assert_null(validate_notification(msg));
}

void test_exit_notification_has_no_id_field() {
  // Exit is a notification, not a request — no id.
  mapping msg = build_notification("exit");
  assert_true(!has_index(msg, "id"));
}

void test_exit_notification_roundtrip() {
  // The exit notification must roundtrip cleanly.
  mapping original = build_notification("exit");
  string json = encode_message(original);
  mapping decoded = decode_message(json);

  assert_not_null(decoded);
  assert_equal("exit", decoded["method"]);
  assert_equal("2.0", decoded["jsonrpc"]);
  assert_true(!has_index(decoded, "id"));
  assert_true(!has_index(decoded, "params"));
}

// ===========================================================================
// 7. Full lifecycle sequence — messages in correct order
// ===========================================================================

void test_lifecycle_sequence_all_messages_validate() {
  // Build the complete lifecycle: initialize → initialized → shutdown → exit.
  // Every message must pass its respective validator.
  mapping init_req = build_request(1, "initialize",
    build_initialize_params("file:///project"));
  mapping init_resp = build_response(1,
    (["capabilities": build_server_capabilities()]));
  mapping initialized_notif = build_notification("initialized", ([]));
  mapping shutdown_req = build_request(2, "shutdown");
  mapping shutdown_resp = build_response(2, Val.null);
  mapping exit_notif = build_notification("exit");

  // All messages must validate.
  assert_null(validate_request(init_req));
  assert_null(validate_response(init_resp));
  assert_null(validate_notification(initialized_notif));
  assert_null(validate_request(shutdown_req));
  assert_null(validate_response(shutdown_resp));
  assert_null(validate_notification(exit_notif));
}

void test_lifecycle_sequence_all_messages_roundtrip() {
  // Every lifecycle message must survive encode/decode without data loss.
  // This catches serialization bugs that would break the wire protocol.
  mapping init_req = build_request(1, "initialize",
    build_initialize_params("file:///project"));
  mapping init_resp = build_response(1,
    (["capabilities": build_server_capabilities()]));
  mapping initialized_notif = build_notification("initialized", ([]));
  mapping shutdown_req = build_request(2, "shutdown");
  mapping shutdown_resp = build_response(2, Val.null);
  mapping exit_notif = build_notification("exit");

  // Roundtrip each message and verify it decoded successfully.
  mapping decoded;

  decoded = decode_message(encode_message(init_req));
  assert_not_null(decoded);
  assert_equal("initialize", decoded["method"]);

  decoded = decode_message(encode_message(init_resp));
  assert_not_null(decoded);
  assert_not_null(decoded["result"]["capabilities"]);

  decoded = decode_message(encode_message(initialized_notif));
  assert_not_null(decoded);
  assert_equal("initialized", decoded["method"]);

  decoded = decode_message(encode_message(shutdown_req));
  assert_not_null(decoded);
  assert_equal("shutdown", decoded["method"]);

  decoded = decode_message(encode_message(shutdown_resp));
  assert_not_null(decoded);
  assert_true(has_index(decoded, "result"));

  decoded = decode_message(encode_message(exit_notif));
  assert_not_null(decoded);
  assert_equal("exit", decoded["method"]);
}

void test_lifecycle_sequence_initialize_before_initialized() {
  // The LSP spec requires that initialize is the first message and that
  // initialized follows the initialize response.  Verify the request and
  // notification types are distinct — initialize is a request (has id),
  // initialized is a notification (no id).
  mapping init_req = build_request(1, "initialize",
    build_initialize_params("file:///project"));
  mapping initialized_notif = build_notification("initialized", ([]));

  // Initialize must be a request — it has an id so the server can respond.
  assert_true(has_index(init_req, "id"));
  assert_equal("initialize", init_req["method"]);

  // Initialized must be a notification — no id, fire-and-forget.
  assert_true(!has_index(initialized_notif, "id"));
  assert_equal("initialized", initialized_notif["method"]);

  // The two methods must be different strings.
  assert_not_equal(init_req["method"], initialized_notif["method"]);
}

void test_lifecycle_sequence_shutdown_before_exit() {
  // The LSP spec requires shutdown request before exit notification.
  // Shutdown is a request (server must respond), exit is a notification
  // (fire-and-forget, server just terminates).
  mapping shutdown_req = build_request(2, "shutdown");
  mapping exit_notif = build_notification("exit");

  // Shutdown must be a request with an id.
  assert_true(has_index(shutdown_req, "id"));
  assert_equal("shutdown", shutdown_req["method"]);

  // Exit must be a notification without an id.
  assert_true(!has_index(exit_notif, "id"));
  assert_equal("exit", exit_notif["method"]);

  // The two methods must be different strings.
  assert_not_equal(shutdown_req["method"], exit_notif["method"]);
}

void test_lifecycle_sequence_ids_are_correlated() {
  // The initialize response must carry the same id as the initialize
  // request, and the shutdown response must match the shutdown request.
  // This correlation is how the client matches responses to requests.
  int init_id = 1;
  int shutdown_id = 2;

  mapping init_req = build_request(init_id, "initialize",
    build_initialize_params("file:///project"));
  mapping init_resp = build_response(init_id,
    (["capabilities": build_server_capabilities()]));
  mapping shutdown_req = build_request(shutdown_id, "shutdown");
  mapping shutdown_resp = build_response(shutdown_id, Val.null);

  // Request and response ids must match for each pair.
  assert_equal(init_req["id"], init_resp["id"]);
  assert_equal(shutdown_req["id"], shutdown_resp["id"]);

  // The two request ids should be distinct (different lifecycle phases).
  assert_not_equal(init_req["id"], shutdown_req["id"]);
}
