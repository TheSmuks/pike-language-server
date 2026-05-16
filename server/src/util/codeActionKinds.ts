/**
 * LSP CodeAction kind constants used across the server.
 *
 * The `vscode-languageserver` CodeActionKind type is a string literal union
 * that includes well-known kinds. We define constants here so that code
 * action producers use properly typed values instead of bare string casts.
 */

/**
 * Refactor rewrite kind — used for code actions that rewrite code structure
 * (e.g., generate getters/setters, autodoc templates).
 *
 * The LSP spec defines "refactor.rewrite" as a standard CodeAction kind.
 */
export const CodeActionKindRefactorRewrite = "refactor.rewrite" as const;
