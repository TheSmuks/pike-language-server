# Existing Pike Editor Tooling

Investigation of existing Pike language editor support, tooling, and LSP implementations.

## 1. Emacs pike-mode

- **Name:** pike-mode (built into GNU Emacs via cc-mode)
- **URL:** http://doc.endlessparentheses.com/Fun/pike-mode.html
- **Scope:** Major mode for editing Pike code. Part of Emacs' cc-mode.el, which also provides c-mode, c++-mode, java-mode, etc. Provides indentation, electric characters (parens, braces, colons), comment toggling, macro expansion, style-based formatting, and syntactic navigation (beginning/end of defun, mark function, forward/backward conditional). Includes hooks for `c-mode-common-hook` and `pike-mode-hook`.
- **Current state:** **Active** — ships with every GNU Emacs installation. Maintained as part of cc-mode, which is one of the most mature Emacs packages. Not independently developed; inherits all cc-mode improvements.
- **What we can learn:** Pike's C-like syntax enabled it to ride on cc-mode for decades. The mode provides no semantic analysis — no completion, no go-to-definition, no diagnostics. It is purely structural (indentation, navigation by block). This confirms that semantic tooling has never existed for Pike in Emacs.

## 2. Vim/Neovim Support

- **Name:** Vim built-in Pike syntax
- **URL:** https://github.com/vim/vim/blob/master/runtime/filetype.vim
- **Scope:** Vim ships `pike.vim` as a built-in syntax file and filetype. This provides basic syntax highlighting (keywords, types, strings, comments). No indentation rules specific to Pike beyond C-like defaults. No omni-completion, no compiler integration.
- **Current state:** **Active but minimal** — included in Vim runtime, rarely updated. The syntax file covers core language constructs but does not track newer Pike features.
- **Tree-sitter:** No tree-sitter grammar for Pike exists. The `Pike/tree-sitter` GitHub organization is a fork of the tree-sitter project itself (the parsing framework), not a Pike grammar. The nvim-treesitter project has no Pike parser listed.
- **What we can learn:** Vim users get colorization and nothing more. The lack of a tree-sitter grammar is a gap that affects not just Vim but any tool that could use incremental parsing. A Pike tree-sitter grammar would benefit Neovim, Helix, and other modern editors.

## 3. VS Code Extensions

### 3a. Pike Language (undeadfish/vscode-pike-lang)

- **Name:** Pike Language
- **URL:** https://marketplace.visualstudio.com/items?itemName=undeadfish.vscode-pike-lang / https://github.com/GwennKoi/vscode-pike-lang
- **Scope:** Syntax highlighting and snippets for Pike. Based on the Sublime Text syntax definition from `poppa/pike-for-sublime`. Includes Roxen CMS snippets. Provides language configuration (bracket matching, comment toggling). ~1.5K installs.
- **Current state:** **Low activity** — version 0.2.0, 1 open issue, 4 stars. The most recent meaningful update added the icon and some metadata. No LSP integration, no diagnostics, no completion beyond static snippets.
- **What we can learn:** This is the de-facto VS Code extension. It proves there is a user base (1.5K installs) but zero semantic features. The VS Code marketplace is where a Pike LSP extension would be published.

### 3b. Pike Debugger (~hww3/vscode-debugger-pike)

- **Name:** vscode-debugger-pike
- **URL:** https://hg.sr.ht/~hww3/vscode-debugger-pike
- **Scope:** Debug Adapter Protocol (DAP) extension for Pike. Supports breakpoints, variable inspection/modification, stepping. Requires Pike compiled with `--with-debug` and works best with `--without-machine-code`. Handles the nuances of Pike's compilation model (preprocessor, `compile_string()`, programs not registered with the master).
- **Current state:** **Unknown** — hosted on sourcehut (Mercurial). Written by hww3 (Bill Welliver), a long-time Pike community member. No obvious activity metrics on sourcehut. The documentation is thorough and describes real limitations in Pike's debug subsystem.
- **What we can learn:** A DAP implementation already exists. The LSP project should coordinate with or at least be aware of this debugger, since both need to understand Pike's compilation model. The notes on breakpoints in included files and programs compiled outside the master are directly relevant to LSP go-to-definition.

## 4. LSP Implementations

### 4a. TheSmuks/pike-lsp

- **Name:** Pike LSP
- **URL:** https://github.com/TheSmuks/pike-lsp
- **Scope:** Full LSP implementation for Pike. TypeScript + Pike bridge architecture. Features include: code completion, hover, diagnostics, signature help, go-to-definition, find references, rename, call hierarchy, type hierarchy, code lens, code actions, formatting, inlay hints, workspace symbols, document links, linked editing. Extensive Roxen framework support (RXML templates, `.rjs`, mixed content, tag catalog integration). Alpha status, MIT licensed.
- **Current state:** **Active (Alpha)** — 3 stars, 3 forks, 8 open issues. Has CI (GitHub Actions), benchmarks, Docker support, and 223 Roxen-specific tests. Published to VS Code Marketplace as "Pike Language Support". Built with Bun, targets Node.js 18+ and Pike 8.0+.
- **What we can learn:** This is the most comprehensive existing attempt. It uses a TypeScript LSP server with a Pike subprocess bridge — the Pike side handles parsing and analysis, the TypeScript side handles LSP protocol. This hybrid architecture is a pragmatic choice given Pike's lack of JSON/async primitives. The project's ADR (Architecture Decision Record) for the bridge model is worth reading.

### 4b. hww3/pike-lsp

- **Name:** hww3/pike-lsp (fork of TheSmuks/pike-lsp)
- **URL:** https://github.com/hww3/pike-lsp
- **Scope:** Fork of the same Pike LSP. 0 stars, 0 forks. Identical README and feature set. Likely a personal fork by Bill Welliver for his own modifications.
- **Current state:** **Fork** — no independent development visible.
- **What we can learn:** Confirms community interest. hww3 is also the author of pike-textmate and the debugger extension, suggesting he is exploring the full tooling stack.

## 5. Pike's Own Tools (`pike -x`)

Pike ships several built-in tools accessible via `pike -x <tool>`:

| Tool | Scope |
|------|-------|
| `hilfe` | Interactive REPL. Supports expression evaluation, variable/class declaration, `typeof()`. No editor integration exists. |
| `cgrep` | Context-aware grep that understands Pike tokens, strings, and comments. Standalone CLI tool. |
| `precompile` | Converts `.pmod`/`.pike` to `.c`. Build tool, not editor-facing. |
| `dump` | Compiles and dumps bytecode `.o` files. Build tool. |
| `test_pike` | Test runner for Pike's own test suite. |
| `extract_autodoc` | Extracts AutoDoc documentation from Pike/C source. Could be used for hover docs but no editor integration exists. |
| `pike_to_html` | Syntax highlighting to HTML. Standalone tool. |

- **Current state:** **Active** — shipped with Pike, maintained as part of the Pike distribution.
- **What we can learn:** None of these tools have editor integration. `hilfe` is the most interesting for an LSP — it can evaluate expressions and provide runtime type information. `extract_autodoc` could provide documentation for hover. `cgrep` could power find-references if it understood cross-file relationships. The Pike distribution does not ship any editor plugins, syntax files, or LSP-related tooling.

## 6. Roxen WebServer

- **Name:** Roxen WebServer / Roxen CMS
- **URL:** https://github.com/pikelang/Roxen / https://github.com/roxen-ab
- **Scope:** Roxen is the primary commercial product built on Pike. The Roxen repository on GitHub is open source. Roxen includes an admin web interface with a built-in code editor for RXML templates and Pike modules. The editor component documentation exists at `https://extranet.roxen.com/support/docs/6.1/roxen/6.1/system_developer_manual/cms-modules/editor-components/implementation.xml.html`.
- **Current state:** **Active** — Roxen AB continues commercial development. The GitHub repo has open issues and activity.
- **What we can learn:** Roxen's built-in editor is web-based and minimal. Roxen developers are a primary audience for a Pike LSP. The TheSmuks/pike-lsp already has extensive Roxen-specific features (223 tests), confirming this is a key use case.

## 7. Other Editor Support

### Sublime Text (poppa/pike-for-sublime)

- **Name:** Pike syntax bundle for Sublime Text
- **URL:** https://github.com/poppa/pike-for-sublime
- **Scope:** Comprehensive syntax definition, snippets (18 snippets including Roxen-specific ones), and completions for Sublime Text. Uses a custom JSON-to-XML pipeline (written in Pike) to generate `.tmLanguage` files. 12 stars, 8 forks. Known issues with `#define` macro parsing and some edge cases in class method return types.
- **Current state:** **Low activity** — 0 open issues, but the known issues in the README suggest it is not actively maintained.
- **What we can learn:** This is the most complete TextMate grammar for Pike. It is the basis for the VS Code extension and the GitHub Linguist grammar. Its known parsing issues (macros, return type annotations) are relevant to any syntax-based tooling.

### Kate Editor

- **Name:** Kate Pike syntax highlighting
- **URL:** https://kate-editor.org/syntax/data/html/highlight.pike.html
- **Scope:** Built-in syntax highlighting file for Kate. Includes a test file (`highlight.pike`) that exercises various Pike constructs.
- **Current state:** **Active** — maintained as part of the Kate syntax highlighting repository.
- **What we can learn:** Kate has Pike support out of the box, but only at the syntax level.

### GitHub Linguist (pike-textmate)

- **Name:** pike-textmate
- **URL:** https://github.com/hww3/pike-textmate
- **Scope:** TextMate bundle for Pike, used by GitHub Linguist for syntax highlighting of `.pike` and `.pmod` files on GitHub. Includes syntax definition, commands (comment toggle, Hilfe integration, manual lookup), and snippets (class, method). This is what powers Pike syntax highlighting on GitHub.
- **Current state:** **Low activity** — 0 stars, 1 fork, 1 open issue. Maintained by hww3 (Bill Welliver).
- **What we can learn:** GitHub's Pike rendering depends on this bundle. It is separate from the Sublime grammar and may have different coverage.

### pike-text-editor/pike (Unrelated)

- **Name:** Pike — Perfectly Incomplex Konsole Editor
- **URL:** https://github.com/pike-text-editor/pike
- **Scope:** A nano-style TUI text editor written in Rust. Named "Pike" but has **no connection to the Pike programming language**. It is a general-purpose text editor, not Pike-specific tooling.
- **Current state:** Active development (Rust project).
- **What we can learn:** Nothing for Pike language tooling. Notable only because the name causes search confusion.

## 8. Tree-sitter Grammar for Pike

A tree-sitter grammar for Pike now exists: [tree-sitter-pike](https://github.com/TheSmuks/tree-sitter-pike). It provides incremental parsing for `.pike` and `.pmod` files and is used by this LSP project as its syntactic parser. The grammar is actively maintained and covers core language constructs including classes, inheritance, imports, type annotations, and preprocessor directives.
## Summary: What the Pike LSP Project Can Learn

### The landscape is almost empty

Pike has basic syntax highlighting in Emacs, Vim, Kate, Sublime, VS Code, and on GitHub. None of these provide semantic features. The only meaningful LSP implementation is TheSmuks/pike-lsp (alpha).

### Key takeaways

1. **No machine-readable compiler output.** Every existing tool parses human-readable error text or regex-matches source. The LSP must wrap `pike` compiler invocations and parse stderr. There is no JSON output mode, no AST dump, no structured diagnostics API.

2. **The TextMate grammar ecosystem is fragmented.** Three separate Pike TextMate grammars exist (Sublime, pike-textmate for GitHub, VS Code extension). All have known gaps (macro parsing, return type annotations). A canonical grammar that all editors use would help.

3. **The hybrid architecture is proven.** TheSmuks/pike-lsp uses TypeScript for LSP protocol + Pike subprocess for analysis. This is the only viable approach: Pike lacks async I/O and JSON primitives suitable for a standalone LSP server, but it has the best knowledge of its own type system and module resolution.

4. **Roxen is a primary use case.** Both the Sublime bundle and the VS Code extension include Roxen-specific snippets. TheSmuks/pike-lsp has 223 Roxen-specific tests. A Pike LSP must handle `.pike`, `.pmod`, `.inc`, RXML templates, and mixed content.

5. **A debugger already exists.** The vscode-debugger-pike extension provides DAP support. The LSP and DAP implementations should be compatible, particularly around file resolution and program identity.

6. **Runtime introspection is limited.** `typeof()` works for expressions but returns `mixed` for object members. The LSP cannot rely on runtime type information for hover/completion of class members — it needs compile-time analysis.

7. **No tree-sitter grammar exists.** This is an opportunity. A Pike tree-sitter grammar would benefit multiple editors and could provide the incremental parsing foundation that the LSP needs for features like semantic tokens and folding ranges.
