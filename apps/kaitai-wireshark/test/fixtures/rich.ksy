meta:
  id: rich
  endian: le
  imports: [sub]
  -wireshark: {udp-port: 9999}
seq:
  - {id: magic, contents: [0x52, 0x49]}
  - {id: ver, type: u1, valid: {min: 1, max: 3}}
  - {id: flag, type: b1}
  - {id: nib, type: b7}
  - {id: name, type: strz, encoding: UTF-8}
  - {id: blen, type: u2}
  - {id: body, size: blen, type: body, process: xor(0x55)}
  - {id: kind, type: u1, enum: kind}
  - id: payload
    type:
      switch-on: kind
      cases:
        'kind::a': sub
        'kind::b': u4
  - {type: u1}
  - {id: rest, size-eos: true}
instances:
  dbl: {value: ver * 2}
  first: {pos: 0, type: u1}
  far: {pos: 64, type: u1, if: ver == 3}
types:
  body:
    seq:
      - {id: x, type: u2, valid: {max: 1000}}
enums:
  kind: {1: a, 2: b}
