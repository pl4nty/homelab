# kaitai-wireshark

Generates a Wireshark Lua dissector from a [Kaitai Struct](https://kaitai.io) `.ksy` spec. The parser is
kaitai-struct-compiler's own Lua output, unchanged, so every `.ksy` feature the compiler supports works: instances,
`switch-on`, expressions, parameters, imports, bit fields, `process`, `valid`. A small glue layer (`src/lua/glue.lua`)
traces the Kaitai Lua runtime to recover each field's byte range and builds the Wireshark tree from it.

```sh
npm ci
node --experimental-strip-types bin/ksy2wireshark.ts spec.ksy -o spec.lua [-I import-dir]...
wireshark -X lua_script:spec.lua capture.pcap   # or copy spec.lua to the personal Lua plugins folder
```

Needs Wireshark 4.4 or later: the compiler's Lua output needs Lua 5.3+, and 4.4 is the first Wireshark that
supports it (4.4 dropped Lua 5.1/5.2 and its Windows and macOS installers ship Lua 5.4,
[release notes](https://www.wireshark.org/docs/relnotes/wireshark-4.4.0.html)).

## Attaching to traffic

Settings go in `meta.-wireshark`. The compiler ignores keys starting with `-`.

```yaml
meta:
  id: do_peer
  -wireshark:
    tcp-port: 7680        # or a list, or "7680,8000-8010"; also editable in Wireshark's protocol preferences
    first-pdu: handshake  # TCP: parsed once at the start of each direction
    pdu: message          # TCP: the record type; defaults to the spec's top-level type
```

| Key | |
|---|---|
| `tcp-port`, `udp-port` | Ports to register on. Every dissector is also offered in *Decode As* for TCP and UDP. |
| `pdu`, `first-pdu` | Type names (`a::b` for nested). Without them, each packet or reassembled TCP PDU parses as the top-level type. |
| `user-dlt` | 0 to 15: register on `USER0`+n, to dissect raw files or non-IP captures (e.g. `text2pcap -l 147`). |
| `heuristic` | `tcp`, `udp` or both. Accepts a payload that parses completely. Only allowed when the first `seq` field is a `contents` or `valid` magic. |
| `name` | The protocol's filter name. Defaults to `meta.id`; if Wireshark already has a protocol by that name, `ks_<id>`. |

Field filter names are `<name>.<field>` for the top-level type and `<name>.<type path>.<field>` for others, e.g.
`do_peer.message.len`, `do_peer.block_ref.begin`. The type path is the type's, not the field's, so a type used in
several places has one set of filters.

## How it works

- `src/index.ts` (no Node APIs, so the VS Code extension bundles it for vscode.dev) compiles the spec with the
  caller's kaitai-struct-compiler (`-t lua`), derives a schema from the `.ksy` (each type's Lua class, its fields and
  their Wireshark types, enums), and writes one Lua file: the Kaitai Lua runtime, the compiled modules, the schema and
  the glue. The modules load into a private environment, so two Kaitai dissectors don't share runtime state.
- The glue wraps `KaitaiStream:read_*` to record the range of each read, `class.class` to see each field assignment,
  and `KaitaiStream` construction to map substreams back to their parent. A field's range is the last read before
  its assignment; a field assigned with no read since the last one (a value instance) is shown as generated.
- `process` output (xor, rotate, zlib) is a new data source named after the field. zlib uses Wireshark's
  decompressor.
- TCP: a read past the end of the buffer asks TCP for more bytes (the exact shortfall when known), then the PDU is
  parsed again from its start. Several PDUs in one segment are dissected in turn.
- Errors: a failed `valid`/`contents` is marked on its field; a short read or bad data is marked on the PDU, naming
  the last field read. Over TCP, an error stops dissection of that direction, since record boundaries after it can't
  be trusted. An instance that fails is marked and doesn't stop the others.
- `-webide-representation` (the Web IDE's key) gives a type's summary in the tree and the Info column:
  `'{index} begin={begin} len={data.length}'`, with `:hex`, `:dec` or `:str` after a path.

## VS Code

The Kaitai IDE extension (`apps/vscode-kaitai`) calls `generateDissector` to export a dissector for the open spec.
In the other direction, each dissector adds *Kaitai → Open … in Kaitai IDE* to Wireshark's packet menu: it writes the
selected frame's first PDU to a temp file and opens it in the extension with the spec (the *Kaitai Struct spec*
protocol preference, set from where the dissector was generated).

## Limits

- Bit fields are shown with byte ranges, not bit masks.
- Strings: the Kaitai Lua runtime decodes ASCII and UTF-8 only.
- Every instance is evaluated on every dissection.
- A TCP PDU type ending in `size-eos` or `repeat: eos` consumes the rest of the segment, so set `pdu` to a
  length-delimited record type.
- A capture that starts mid-connection fails on its first segment when `first-pdu` is set.

## Tests

`npm test` runs the generator against tshark (skipped when tshark is missing; run as a non-root user, or as root
with a `ws` user, since tshark won't load Lua plugins as root): the DO peer protocol capture as captured and
resegmented at 7 to 65000 bytes, a UDP spec covering bit fields, xor, imports, switch and instances, zlib, error
marking, and specs from kaitai_struct_formats cross-checked against Wireshark's own dissectors (`test/formats`).
