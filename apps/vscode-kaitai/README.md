# Kaitai Struct IDE

Parse binary files with [Kaitai Struct](https://kaitai.io/) specs in VS Code. Features a coloured hex view, structure tree, format library, and LSP/hot-reload for spec editing. It also supports VS Code for the Web (vscode.dev, github.dev) as well as desktop.

![Hex view coloured by field, with the structure tree and the Value view](https://raw.githubusercontent.com/pl4nty/homelab/main/apps/vscode-kaitai/media/screenshots/hero.png)

## Quick start

1. Right-click a binary file and select **Open in Kaitai Hex Editor**.
2. Open the Kaitai Struct view in the activity bar.
3. Select **Load Spec...**, or pick a spec from Formats. Specs that match the file extension are listed first.

| Structure | Value | Formats |
| --- | --- | --- |
| ![Structure tree of a PNG file](https://raw.githubusercontent.com/pl4nty/homelab/main/apps/vscode-kaitai/media/screenshots/structure.png) | ![Value view with integer, float, time and string decodings at the caret](https://raw.githubusercontent.com/pl4nty/homelab/main/apps/vscode-kaitai/media/screenshots/value.png) | ![Formats view with a spec suggested for .png](https://raw.githubusercontent.com/pl4nty/homelab/main/apps/vscode-kaitai/media/screenshots/formats.png) |

## Features

Explore

- **Read-only hex view**: coloured fields with nesting, error regions, and virtualised rows for large files. Press `]` and `[` to step through fields, and `N` to jump to the next unparsed gap.
- **Structure view**: a lazy tree that stays in sync with the hex selection. It shows enum labels, parses instances on expand, and marks failed fields.
- **Value view**: integers, floats, Unix times and strings at the caret, little-endian and big-endian side by side.
- **Formats**: choose from thousands of specs via `pl4nty/kaitai_struct_formats` (set `kaitai.formatsRepository` to change it). It also resolves absolute imports that are not in your workspace.
- **Find Value in File...** (Ctrl+F): `u4le 1234`, `f4 1.5`, `"text"`, `utf-16le "text"`, or hex with `??` wildcards.
- **Go to Offset...** (Ctrl+G): an offset or a range, such as `0x10-0x20` or `0x10+16`.
- Copy As..., Export Parsed Tree as JSON and Save Bytes As....
- Open Bytes in Hex Editor: view the decoded bytes of a `process:` field (zlib, xor, rotate).

Write specs

- **LSP**: suggestions, schema validation, hover, and go-to-definition.
- **Hot reload**: an edit to the `.ksy` or its imports, saved or not, reparses each open file that uses it.
- **Add Field from Selection...**: select bytes, choose a type, and the `seq` entry is inserted into the spec.
- **Parse Selection as Type...**: try a type from the spec on the selected bytes.
- **Set Spec Params...** for specs with top-level `params`.
- **Show Generated Code...** for every compiler target.

## Limits

- The hex view is read-only, and the whole file is read into memory (`kaitai.maxFileSizeMB`, default 256).
- Compiled specs run as JavaScript in the extension host. Only load specs that you trust.
- Fields inside a processed stream have no file position, so they have no colour. Open the stream to see them.
