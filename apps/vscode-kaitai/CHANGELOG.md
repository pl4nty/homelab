# Changelog

## 0.2.0

- Registers a Kaitai MCP server with VS Code's agent mode (VS Code 1.101 or later, desktop and remote): tools to parse a
  file, explain the bytes at an offset, suggest a gallery spec, validate a .ksy and generate code. The same server and a
  `kaitai` CLI are on npm as `kaitai-mcp`.

## 0.1.0

First release.

- Kaitai Hex Editor: field-coloured, virtualised hex view with selection, Go to Offset, Find and Copy As.
- Structure tree, Value view (LE/BE decodings at the caret) and Formats (the format gallery, with suggestions by file extension).
- .ksy language support: diagnostics, completion, hover, go to definition, outline, quick fixes, generated code.
- Works in VS Code for the Web (vscode.dev) and on desktop.
