# kaitai-mcp

Parse binary files with [Kaitai Struct](https://kaitai.io/) `.ksy` specs from a terminal or an AI agent. It bundles the
Kaitai Struct compiler (Scala.js build) and JavaScript runtime, so it needs only Node 20 or later: no Java, no `ksc`,
no Ruby. It is the engine of the [Kaitai Struct IDE](https://github.com/pl4nty/homelab/tree/main/apps/vscode-kaitai)
VS Code extension, which also registers this MCP server with VS Code's agent mode.

## MCP server

```json
{
  "mcpServers": {
    "kaitai": { "command": "npx", "args": ["-y", "kaitai-mcp"] }
  }
}
```

For Claude Code: `claude mcp add kaitai -- npx -y kaitai-mcp`.

| Tool | What it does |
| --- | --- |
| `kaitai_suggest` | Gallery specs for a file, from its extension, parsed and ranked by errors and coverage. |
| `kaitai_parse` | The parsed tree, a few levels at a time. Drill down with `path` (`chunks[3].body`) and page arrays with `from`. |
| `kaitai_at` | The field at a file offset, with the structs that contain it. |
| `kaitai_validate` | YAML and compiler errors with line/column and "did you mean" fixes, for specs an agent writes. |
| `kaitai_compile` | Parser source code in any compiler target (Python, Rust, Go, C++, Java, …). |

Outputs are JSON with byte ranges as `[start, end)` file offsets. They are capped (depth 3, 20 items per array,
400 nodes by default) and say what was cut (`"truncated": "depth" | "items" | "nodes"`), so a large file cannot flood
the agent's context.

## CLI

```sh
npx -p kaitai-mcp kaitai suggest photo.png --try
npx -p kaitai-mcp kaitai parse gallery:image/png photo.png --depth 2
npx -p kaitai-mcp kaitai parse my.ksy data.bin --path 'records[10]' --json
npx -p kaitai-mcp kaitai at gallery:image/png photo.png 0x21
npx -p kaitai-mcp kaitai validate my.ksy
npx -p kaitai-mcp kaitai compile my.ksy -l python -o out/
```

Run `kaitai --help` for every option. Installed globally (`npm i -g kaitai-mcp`), the commands are `kaitai` and
`kaitai-mcp`.

## Specs and imports

A spec is a `.ksy` path, `-` for stdin, or `gallery:<path>` for a file in the format gallery
([pl4nty/kaitai_struct_formats](https://github.com/pl4nty/kaitai_struct_formats) by default; `--repo`, `--ref`,
`KAITAI_FORMATS_REPO`, `KAITAI_FORMATS_REF`). Relative imports resolve from the importing spec's folder; absolute
imports (`/common/vlq_base128_le`) from each ancestor folder, `-I` folders and `KSPATH`, then the gallery.
`--offline` or `KAITAI_OFFLINE=1` turns off the network.

## Notes

- Compiled specs run as JavaScript in the server process. Only use specs you trust.
- The whole file is read into memory (limit `KAITAI_MAX_FILE_MB`, default 256).
- Fields inside processed (e.g. decompressed) streams have no file offset.
- The MCP server caches compiled specs by source; restart it after editing an imported spec.

## Licence

GPL-3.0-or-later, because it bundles the Kaitai Struct compiler (GPL-3.0).
