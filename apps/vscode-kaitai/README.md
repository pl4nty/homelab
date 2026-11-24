# Kaitai Struct IDE for VS Code

Parse binary files with [Kaitai Struct](https://kaitai.io/) `.ksy` specs inside VS Code. It runs in **VS Code for the Web** (vscode.dev, github.dev) as well as desktop VS Code and code-server. It covers what the Kaitai Web IDE does, using your workspace files instead of browser storage, and adds features the Web IDE lacks.

## Try it on vscode.dev

vscode.dev's Content Security Policy only lets **Developer: Install Extension from Location…** fetch from `localhost` (and Microsoft's Marketplace hosts), so a hosted copy can't be installed from another domain.

1. Build and serve it locally: `npm install && npm run build && PUBLIC_DIR=. bun server/serve.mjs 8787`.
2. Open https://vscode.dev (or a github.dev repository) in Chrome or Edge, run **Developer: Install Extension from Location…**, and enter `http://localhost:8787`.
3. Open a binary file, then right-click its tab or explorer entry and select **Open in Kaitai Hex Editor**.
4. In the **Kaitai Struct** activity bar, use **Load Spec…**, or pick a format from the **Format Gallery**.

The container image (`server/serve.mjs` behind `https://vscode-kaitai.${PUBLIC_DOMAIN}`) serves the same files with CORS for code-server and other self-hosted workbenches whose CSP allows it.

## Features

| Area | What it does |
| --- | --- |
| Hex editor | Virtualised hex and ASCII view (large files), field-coloured regions with nesting and borders, error regions, hover labels, caret and range selection, keyboard navigation, jump to next unparsed gap or next field. |
| Structure tree | Lazy tree of the parse result. Enums show labels, arrays over 100 items are bucketed, instances parse on expand, and failed fields and instances are marked. Two-way sync with the hex selection. Expansion survives reparses. |
| Live reparse | Editing the `.ksy` (saved or not), or any file it imports, reparses every open file that uses it. Changing the binary on disk reloads it. |
| Diagnostics | Compile and YAML errors in the Problems panel at the right `.ksy` line, including errors inside imported specs. |
| Language features | Completion, hover docs, go to definition (types, enums, imports, fields), outline for `.ksy`. |
| Generated code | **Show Generated Code…** for every compiler target (C++, C#, Go, Java, JavaScript, Lua, Nim, Perl, PHP, Python, Ruby, Rust, Construct, Graphviz, HTML), with debug variants. |
| Value inspector | Integers (8 to 64 bit), floats, Unix times and string previews at the caret, both endiannesses side by side. |
| Format gallery | Browse and use specs from `pl4nty/kaitai_struct_formats` (configurable). Absolute imports such as `/common/vlq_base128_le` resolve from the gallery when they are not in the workspace. |
| Export | Whole tree to JSON, a subtree to the clipboard, a field's bytes to a file. |

Beyond the Web IDE:

- **Spec params**: specs with top-level `params` can be parsed (**Set Spec Params…**).
- **Parse selection as type**: try any user type on the selected bytes, as an extra root in the tree.
- **Add field from selection**: select bytes, choose a type, and a `seq` entry (plus a gap field if needed) is inserted into the spec at the right place.
- **Decompressed streams**: open the bytes of a `process:`ed field (zlib, xor, rotate) in their own hex editor.
- **Typed search** (Ctrl+F in the hex editor): `u4le 1234`, `f4 1.5`, `"text"`, `utf-16le "text"`, or hex with `??` wildcards.
- **`-webide-representation`** labels on structs, e.g. `'{name}: {value:dec}'`.
- Each file remembers its spec, and a spec applies to other files that match its `meta/file-extension`.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `kaitai.formatsRepository` | `pl4nty/kaitai_struct_formats` | GitHub repo of the format gallery |
| `kaitai.formatsRef` | `master` | Branch, tag or commit of the gallery |
| `kaitai.maxFileSizeMB` | `256` | Refuse to parse larger files (the parser needs the whole file in memory) |
| `kaitai.hexEditor.bytesPerRow` | `16` | Bytes per row |
| `kaitai.autoApplyByExtension` | `true` | Apply a spec to other files matching its `meta/file-extension` |

## Development

```sh
npm install
npm test          # unit tests (node:test)
npm run typecheck
npm run build     # dist/node, dist/web, dist/webview
npm run package   # .vsix
```

Press F5 in VS Code with this folder open to run it in an Extension Development Host. `bun server/serve.mjs 8787` with `PUBLIC_DIR=.` serves the built web extension locally for "Install Extension from Location".

## Notes and limits

- Compiled parsers run as JavaScript in the extension host, which is why untrusted workspaces get limited support.
- The whole file is read into memory. Fields are only decoded when their tree node is expanded.
- Bit-sized fields highlight the bytes they were read from, because the compiler's debug output has byte positions only.
- Fields inside processed streams have no position in the file, so they are not coloured; open the stream to see them.

## Licence

GPL-3.0-or-later, because it bundles the Kaitai Struct compiler (GPL-3.0). The runtime (`kaitai-struct`) is Apache-2.0. The parser engine started from the Kaitai support in pl4nty/vscode-hexeditor's structure view.
