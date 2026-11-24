meta:
  id: zpkt
  title: zlib test packet
  endian: be
  -wireshark:
    udp-port: 9100
seq:
  - id: len
    type: u2
  - id: body
    size: len
    process: zlib
    type: inner
types:
  inner:
    -webide-representation: '{greeting} n={n}'
    seq:
      - id: greeting
        type: strz
        encoding: ASCII
      - id: n
        type: u4
