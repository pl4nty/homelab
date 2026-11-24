# kaitai-wireshark

Generates a Wireshark Lua dissector from a [Kaitai Struct](https://kaitai.io) `.ksy` spec. The parser is
kaitai-struct-compiler's own Lua output, unchanged, so every `.ksy` feature the compiler supports works: instances,
`switch-on`, expressions, parameters, imports, bit fields, `process`, `valid`. A glue layer (`src/lua/glue.lua`)
traces the Kaitai Lua runtime to recover each field's byte range and builds the Wireshark tree from it.

```sh
npm ci
npm run embed   # fetches the Kaitai Lua runtime at the commit pinned in scripts/embed.ts
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
    tcp-port: 7680        # or a list, or "7680,8000-8010"
    first-pdu: handshake  # TCP: parsed once at the start of each direction
    pdu: message          # TCP: the record type; defaults to the spec's top-level type
```

| Key | |
|---|---|
| `tcp-port`, `udp-port` | Ports to register on. Every dissector is also offered in *Decode As* for TCP and UDP. |
| `pdu`, `first-pdu` | Type names (`a::b` for nested). Without them, each packet or reassembled TCP PDU parses as the top-level type. |
| `user-dlt` | 0 to 15: register on `USER0`+n, to dissect raw files or non-IP captures (e.g. `text2pcap -l 147`). |

The protocol's filter name is `meta.id`, or `ks_<id>` if Wireshark already has a protocol by that name. Field filter
names are `<name>.<field>` for the top-level type and `<name>.<type path>.<field>` for others, e.g.
`do_peer.message.len`, `do_peer.block_ref.begin`. The type path is the type's, not the field's, so a type used in
several places has one set of filters.

## How it works

- `src/index.ts` (no Node APIs, so the VS Code extension bundles it for vscode.dev) is a concatenator. It compiles
  the spec with the caller's kaitai-struct-compiler (`-t lua`) and writes one Lua file: the Kaitai Lua runtime and
  the compiled modules as strings, the spec and its imports as Lua tables, and the glue. The generator is
  JavaScript only because the compiler is (it ships for npm and the JVM); everything else is Lua. The runtime isn't
  checked in: `npm run embed` (run before `typecheck` and `test`) fetches it and writes the git-ignored
  `src/lua-sources.generated.ts`, so a bundler using `src/index.ts` runs it first.
- At load, the glue runs the modules in a private environment (so two Kaitai dissectors don't share runtime state)
  and walks the spec for what Wireshark needs before the first packet: a field per attribute and instance, typed
  from its `type`, with its enum's labels and the first line of its `doc`.
- The glue wraps `KaitaiStream:read_*` to record the range of each read, `class.class` to see each field assignment,
  and `KaitaiStream` construction to map substreams back to their parent. A field's range is the last read before
  its assignment; a field assigned with no read since the last one (a value instance) is shown as generated.
- `process` output (xor, rotate, zlib) is a new data source named after the field. zlib uses Wireshark's
  decompressor.
- TCP: a read past the end of the buffer asks TCP for more bytes (the exact shortfall when known), then the PDU is
  parsed again from its start. Several PDUs in one segment are dissected in turn.
- Errors: a failed `valid`/`contents` is marked on its field; a short read or bad data is marked on the PDU, naming
  the last field read, and the structs being read show as `<type> (incomplete)` with the fields read so far. Over
  TCP, an error stops dissection of that direction, since record boundaries after it can't be trusted. An instance
  that fails is marked and doesn't stop the others; instance evaluation stops after 4096 structs (a DNS name that
  points at itself).
- `-webide-representation` (the Web IDE's key) gives a type's summary in the tree and the Info column:
  `'{index} begin={begin} len={data.length}'`.

## VS Code

The Kaitai IDE extension (`apps/vscode-kaitai`) calls `generateDissector` to export a dissector for the open spec.
In the other direction, each dissector adds *Kaitai → Open … in Kaitai IDE* to Wireshark's packet menu: it writes the
selected frame's first PDU to a temp file and opens
`vscode://pl4nty.kaitai-ide/open?data=<the file>&ksy=<the spec>`, the spec being the *Kaitai Struct spec* protocol
preference (set from where the dissector was generated).

## Limits

- Bit fields are shown with byte ranges, not bit masks.
- Strings: the Kaitai Lua runtime decodes ASCII and UTF-8 only.
- Every instance is evaluated on every dissection, after the `seq` fields and in alphabetical order.
- A TCP PDU type ending in `size-eos` or `repeat: eos` consumes the rest of the segment, so set `pdu` to a
  length-delimited record type.
- A capture that starts mid-connection fails on its first segment when `first-pdu` is set.
- A `pdu` or `first-pdu` type is parsed on its own, so it can't use `_root` or `_parent`.
- Value instances are string fields, so filters compare them as text. So are bytes that `terminator` or `pad-right`
  shortened.
- `:hex`, `:dec` and `:str` in a `-webide-representation` are ignored.

## Tests

`npm test` runs the generator against tshark (skipped when tshark is missing; run as a non-root user, or as root
with a `ws` user, since tshark won't load Lua plugins as root): the fields a spec registers, the DO peer protocol
capture as captured and resegmented at 7 to 3000 bytes, a UDP spec covering bit fields, xor, imports, switch and
instances, zlib, error marking, and specs from kaitai_struct_formats (`KSF_DIR`, default a sibling checkout)
cross-checked against Wireshark's own DNS, Ethernet/VLAN/IPv4/IPv6/TCP/UDP/ICMP, RTP and TLS dissectors, values and
byte ranges (`test/formats`). `KAITAI_WIRESHARK_REQUIRE=1` (set in CI) fails instead of skipping when tshark or the
specs are missing.
