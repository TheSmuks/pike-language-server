//! LspProtocol.pmod — JSON-RPC 2.0 / LSP protocol message builders and validators
//!
//! Provides pure-function helpers for constructing, parsing, and validating
//! JSON-RPC 2.0 messages used by the LSP protocol and the Pike worker IPC.
//!
//! Methodology: Each builder returns a Pike mapping that can be serialized via
//! Standards.JSON.encode(). Validators return 0 on success or a descriptive
//! error string on failure, enabling clean assertion patterns.

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 message builders
// ---------------------------------------------------------------------------

//! Build a JSON-RPC 2.0 request message.
//! @param id      Request identifier (int or string)
//! @param method  Method name
//! @param params  Optional parameters mapping
//! @returns A mapping representing a JSON-RPC request
mapping build_request(int|string id, string method, void|mapping params) {
  mapping msg = ([ "jsonrpc": "2.0", "id": id, "method": method ]);
  if (params) msg["params"] = params;
  return msg;
}

//! Build a JSON-RPC 2.0 notification (no id field).
//! @param method  Method name
//! @param params  Optional parameters mapping
//! @returns A mapping representing a JSON-RPC notification
mapping build_notification(string method, void|mapping params) {
  mapping msg = ([ "jsonrpc": "2.0", "method": method ]);
  if (params) msg["params"] = params;
  return msg;
}

//! Build a JSON-RPC 2.0 success response.
//! @param id      Request identifier (must match the request)
//! @param result  Result payload
//! @returns A mapping representing a JSON-RPC success response
mapping build_response(int|string id, mixed result) {
  return ([ "jsonrpc": "2.0", "id": id, "result": result ]);
}

//! Build a JSON-RPC 2.0 error response.
//! @param id       Request identifier
//! @param code     Error code (negative for protocol errors)
//! @param message  Human-readable error message
//! @param data     Optional additional error data
//! @returns A mapping representing a JSON-RPC error response
mapping build_error(int|string id, int code, string message, void|mixed data) {
  mapping error = ([ "code": code, "message": message ]);
  if (!zero_type(data)) error["data"] = data;
  return ([ "jsonrpc": "2.0", "id": id, "error": error ]);
}

// ---------------------------------------------------------------------------
// Worker IPC message builders (simplified JSON-RPC without version field)
// ---------------------------------------------------------------------------

//! Build a worker IPC request (matches worker.pike protocol).
//! Worker uses a simplified format: {"id": N, "method": "...", "params": {...}}
//! @param id      Request identifier
//! @param method  Method name (diagnose, ping, typeof, autodoc, resolve)
//! @param params  Parameters mapping
//! @returns A mapping representing a worker IPC request
mapping build_worker_request(int id, string method, mapping params) {
  return ([ "id": id, "method": method, "params": params ]);
}

//! Build a worker IPC success response.
//! @param id      Request identifier
//! @param result  Result mapping
//! @returns A mapping representing a worker IPC success response
mapping build_worker_response(int id, mapping result) {
  return ([ "id": id, "result": result ]);
}

//! Build a worker IPC error response.
//! @param id       Request identifier
//! @param code     Error code
//! @param message  Error message
//! @returns A mapping representing a worker IPC error response
mapping build_worker_error(int id, int code, string message) {
  return ([ "id": id, "error": ([ "code": code, "message": message ]) ]);
}

// ---------------------------------------------------------------------------
// LSP-specific message builders
// ---------------------------------------------------------------------------

//! Build an LSP initialize request.
//! @param rootUri              Workspace root URI
//! @param capabilities         Client capabilities mapping
//! @param initializationOptions Optional initialization options
//! @returns A mapping for the initialize request params
mapping build_initialize_params(string rootUri, void|mapping capabilities,
                                void|mapping initializationOptions) {
  mapping params = ([ "rootUri": rootUri ]);
  if (capabilities) params["capabilities"] = capabilities;
  else params["capabilities"] = ([]);
  if (initializationOptions) params["initializationOptions"] = initializationOptions;
  return params;
}

//! Build a textDocument/didOpen notification params.
//! @param uri         Document URI
//! @param languageId  Language identifier (e.g., "pike")
//! @param version     Document version
//! @param text        Document content
//! @returns A mapping for the didOpen params
mapping build_did_open_params(string uri, string languageId, int version,
                              string text) {
  return ([
    "textDocument": ([
      "uri": uri,
      "languageId": languageId,
      "version": version,
      "text": text,
    ]),
  ]);
}

//! Build a textDocument/didChange notification params (full sync).
//! @param uri      Document URI
//! @param version  New document version
//! @param text     Full document content
//! @returns A mapping for the didChange params (full document sync)
mapping build_did_change_full_params(string uri, int version, string text) {
  return ([
    "textDocument": ([ "uri": uri, "version": version ]),
    "contentChanges": ({ ([ "text": text ]) }),
  ]);
}

//! Build a textDocument/didChange notification params (incremental sync).
//! @param uri      Document URI
//! @param version  New document version
//! @param range    The range of the change
//! @param text     The new text for the range
//! @returns A mapping for the didChange params (incremental sync)
mapping build_did_change_incremental_params(string uri, int version,
                                            mapping range, string text) {
  return ([
    "textDocument": ([ "uri": uri, "version": version ]),
    "contentChanges": ({ ([ "range": range, "text": text ]) }),
  ]);
}

//! Build a textDocument/didClose notification params.
//! @param uri  Document URI
//! @returns A mapping for the didClose params
mapping build_did_close_params(string uri) {
  return ([ "textDocument": ([ "uri": uri ]) ]);
}

//! Build a textDocument/didSave notification params.
//! @param uri      Document URI
//! @param text     Optional full document text
//! @returns A mapping for the didSave params
mapping build_did_save_params(string uri, void|string text) {
  mapping params = ([ "textDocument": ([ "uri": uri ]) ]);
  if (text) params["text"] = text;
  return params;
}

//! Build an LSP Position.
//! @param line      Line number (0-based)
//! @param character Character offset (0-based, UTF-16)
//! @returns A mapping representing an LSP Position
mapping build_position(int line, int character) {
  return ([ "line": line, "character": character ]);
}

//! Build an LSP Range.
//! @param start  Start position mapping
//! @param end    End position mapping
//! @returns A mapping representing an LSP Range
mapping build_range(mapping start, mapping end) {
  return ([ "start": start, "end": end ]);
}

// ---------------------------------------------------------------------------
// Validators — return 0 on success, error string on failure
// ---------------------------------------------------------------------------

//! Validate a JSON-RPC 2.0 request has all required fields.
//! @param msg  The message mapping to validate
//! @returns 0 on success, error string on failure
string validate_request(mapping msg) {
  if (!msg) return "Message is null";
  if (!msg["jsonrpc"]) return "Missing 'jsonrpc' version field";
  if (msg["jsonrpc"] != "2.0") return "Invalid jsonrpc version: expected '2.0'";
  if (!has_index(msg, "id")) return "Missing 'id' field for request";
  if (!msg["method"] || !stringp(msg["method"])) {
    return "Missing or invalid 'method' field";
  }
  if (msg["params"] && !mappingp(msg["params"])) {
    return "'params' must be a mapping if present";
  }
  return 0;
}

//! Validate a JSON-RPC 2.0 notification (request without id).
//! @param msg  The message mapping to validate
//! @returns 0 on success, error string on failure
string validate_notification(mapping msg) {
  if (!msg) return "Message is null";
  if (!msg["jsonrpc"]) return "Missing 'jsonrpc' version field";
  if (msg["jsonrpc"] != "2.0") return "Invalid jsonrpc version: expected '2.0'";
  if (has_index(msg, "id")) return "Notification must not have 'id' field";
  if (!msg["method"] || !stringp(msg["method"])) {
    return "Missing or invalid 'method' field";
  }
  return 0;
}

//! Validate a JSON-RPC 2.0 response (success or error).
//! @param msg  The message mapping to validate
//! @returns 0 on success, error string on failure
string validate_response(mapping msg) {
  if (!msg) return "Message is null";
  if (!msg["jsonrpc"]) return "Missing 'jsonrpc' version field";
  if (msg["jsonrpc"] != "2.0") return "Invalid jsonrpc version: expected '2.0'";
  if (!has_index(msg, "id")) return "Missing 'id' field for response";

  int has_result = has_index(msg, "result");
  int has_error = has_index(msg, "error");

  if (!has_result && !has_error) {
    return "Response must have either 'result' or 'error'";
  }
  if (has_result && has_error) {
    return "Response must not have both 'result' and 'error'";
  }
  if (has_error) {
    mapping err = msg["error"];
    if (!mappingp(err)) return "'error' must be a mapping";
    if (!has_index(err, "code")) return "Error mapping missing 'code' field";
    if (!has_index(err, "message")) return "Error mapping missing 'message' field";
  }
  return 0;
}

//! Validate a worker IPC request (simplified JSON-RPC).
//! @param msg  The message mapping to validate
//! @returns 0 on success, error string on failure
string validate_worker_request(mapping msg) {
  if (!msg) return "Message is null";
  if (!has_index(msg, "id")) return "Missing 'id' field";
  if (!msg["method"] || !stringp(msg["method"])) {
    return "Missing or invalid 'method' field";
  }
  return 0;
}

//! Validate a worker IPC response.
//! @param msg  The message mapping to validate
//! @returns 0 on success, error string on failure
string validate_worker_response(mapping msg) {
  if (!msg) return "Message is null";
  if (!has_index(msg, "id")) return "Missing 'id' field";
  if (!has_index(msg, "result") && !has_index(msg, "error")) {
    return "Response must have either 'result' or 'error'";
  }
  return 0;
}

//! Validate an LSP Position mapping.
//! @param pos  The position mapping
//! @returns 0 on success, error string on failure
string validate_position(mapping pos) {
  if (!pos) return "Position is null";
  if (!has_index(pos, "line")) return "Position missing 'line' field";
  if (!has_index(pos, "character")) return "Position missing 'character' field";
  if (!intp(pos["line"])) return "Position 'line' must be an integer";
  if (!intp(pos["character"])) return "Position 'character' must be an integer";
  if (pos["line"] < 0) return "Position 'line' must be non-negative";
  if (pos["character"] < 0) return "Position 'character' must be non-negative";
  return 0;
}

//! Validate an LSP Range mapping.
//! @param range  The range mapping
//! @returns 0 on success, error string on failure
string validate_range(mapping range) {
  if (!range) return "Range is null";
  if (!range["start"]) return "Range missing 'start' position";
  if (!range["end"]) return "Range missing 'end' position";
  string start_err = validate_position(range["start"]);
  if (start_err) return "Range start: " + start_err;
  string end_err = validate_position(range["end"]);
  if (end_err) return "Range end: " + end_err;
  return 0;
}

//! Validate a textDocument/didOpen params mapping.
//! @param params  The params mapping
//! @returns 0 on success, error string on failure
string validate_did_open_params(mapping params) {
  if (!params) return "Params is null";
  if (!params["textDocument"]) return "Missing 'textDocument' field";
  mapping doc = params["textDocument"];
  if (!doc["uri"]) return "textDocument missing 'uri' field";
  if (!doc["languageId"]) return "textDocument missing 'languageId' field";
  if (!has_index(doc, "version")) return "textDocument missing 'version' field";
  if (!has_index(doc, "text")) return "textDocument missing 'text' field";
  return 0;
}

//! Validate a textDocument/didChange params mapping.
//! @param params  The params mapping
//! @returns 0 on success, error string on failure
string validate_did_change_params(mapping params) {
  if (!params) return "Params is null";
  if (!params["textDocument"]) return "Missing 'textDocument' field";
  mapping doc = params["textDocument"];
  if (!doc["uri"]) return "textDocument missing 'uri' field";
  if (!has_index(doc, "version")) return "textDocument missing 'version' field";
  if (!params["contentChanges"]) return "Missing 'contentChanges' field";
  if (!arrayp(params["contentChanges"])) return "'contentChanges' must be an array";
  if (sizeof(params["contentChanges"]) == 0) return "'contentChanges' must not be empty";
  return 0;
}

//! Validate a textDocument/didClose params mapping.
//! @param params  The params mapping
//! @returns 0 on success, error string on failure
string validate_did_close_params(mapping params) {
  if (!params) return "Params is null";
  if (!params["textDocument"]) return "Missing 'textDocument' field";
  mapping doc = params["textDocument"];
  if (!doc["uri"]) return "textDocument missing 'uri' field";
  return 0;
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

//! Encode a mapping to a JSON string.
//! @param msg  The mapping to encode
//! @returns JSON string
string encode_message(mapping msg) {
  return Standards.JSON.encode(msg);
}

//! Decode a JSON string to a mapping.
//! @param json_str  The JSON string to decode
//! @returns The decoded mapping, or 0 on parse failure
mapping decode_message(string json_str) {
  mixed err = catch {
    mixed decoded = Standards.JSON.decode(json_str);
    if (mappingp(decoded)) return decoded;
    return 0;
  };
  return 0;
}

//! Try to decode a JSON string, returning the error on failure.
//! @param json_str  The JSON string to decode
//! @returns An array: ({ 0, mapping }) on success, ({ error_string, 0 }) on failure
array decode_message_safe(string json_str) {
  mixed err = catch {
    mixed decoded = Standards.JSON.decode(json_str);
    if (mappingp(decoded)) return ({ 0, decoded });
    return ({ "Decoded value is not a mapping", 0 });
  };
  return ({ sprintf("%O", err), 0 });
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 standard error codes
// ---------------------------------------------------------------------------

constant PARSE_ERROR = -32700;
constant INVALID_REQUEST = -32600;
constant METHOD_NOT_FOUND = -32601;
constant INVALID_PARAMS = -32602;
constant INTERNAL_ERROR = -32603;

// Worker-specific error codes
constant WORKER_UNKNOWN_METHOD = -1;
constant WORKER_PARSE_ERROR = -1;
