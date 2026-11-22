# DO peer protocol spec and Wireshark dissector

- `do_peer.ksy`: the [Kaitai Struct](https://kaitai.io) description of one direction of a DO peer connection.
- `ksy2wireshark.py`: generates a Wireshark Lua dissector from a `.ksy` file. Needs Python 3 and PyYAML.
- `do_peer.lua`: the generated dissector. Don't edit it.
- `testdata/fetch.pcap`: a loopback capture of `fetch` downloading a 40 kB file from this peer.

```sh
python3 ksy2wireshark.py do_peer.ksy > do_peer.lua
tshark -X lua_script:do_peer.lua -r testdata/fetch.pcap -Y do_peer -T fields -e frame.number -e _ws.col.info \
  | diff - testdata/fetch.txt
wireshark -X lua_script:do_peer.lua testdata/fetch.pcap
```

tshark 4.2 skips Lua scripts without a message when it runs as root. Wireshark has its own `MS-DO` dissector on
TCP 7680, and this one replaces it while the script is loaded.

To make a new capture, run the peer and capture a fetch:

```sh
tcpdump -i lo -w testdata/fetch.pcap port 7680 &
dotnet run --project ../src/DoPeer -- fetch 127.0.0.1:7680 http://127.0.0.1:8080/pieceshash/file.bin out.bin
```

## What the generator supports

It fails with an error on anything outside this list.

- `meta`: `id`, `title`, `endian` (`be` or `le`), `encoding`.
- `seq` fields: `u1` to `u8` and `s1` to `s8` with an optional `le`/`be` suffix, `str` with `encoding`, byte
  arrays, user types, `size`, `size-eos`, `if`, `repeat: eos`, `enum`, `doc`, and `valid` (a value, `min`, `max` or
  `any-of`).
- `type` with `switch-on` and `cases`, including the `_` default. Without a matching case, a sized field is shown
  as bytes.
- Expressions: integer and string literals, earlier fields of the same type, `enum::value`, arithmetic,
  comparisons, `and`/`or`/`not`, parentheses, and `.length` on a string or byte array (in bytes).
- `enums`, shown by name in title case.

Two keys go beyond plain Kaitai Struct. Both start with `-`, which the Kaitai compiler ignores:

- `meta.-wireshark.tcp-port` (required): the TCP port to register on.
- `-webide-representation` on a type, the Kaitai Web IDE's key: a summary such as `idx={index} begin={begin}`,
  used in the Info column and the tree. Without it, a type's summary is its enum values and the summaries of its
  nested types.

## How a stream is framed

The top-level `seq` must end with a `repeat: eos` field of a user type. That type is the stream's record. Any
fields before it are parsed once at the start of each direction of a TCP connection, and every later byte belongs
to a record. The dissector keeps that state per connection and direction.

A record that runs past the end of a segment asks TCP for more data. When the shortfall is in the record's last
field and that field has a `size`, it asks for the exact number of bytes. Otherwise it asks for one more segment
and tries again.

A `valid` failure adds an expert error and stops dissecting that direction, since the record boundaries can't be
trusted after it. A capture that starts in the middle of a connection fails this way on its first segment.
