meta:
  id: do_peer
  title: Delivery Optimization peer protocol
  application: Windows Delivery Optimization (doclient.dll)
  endian: be
  -wireshark:
    tcp-port: 7680
    first-pdu: handshake
    pdu: message
doc: |
  One direction of a DO peer connection: a handshake, then length-prefixed messages.
  From doclient.dll 10.0.26100.6 (CPeerSock::SendHandShake, CPeerSock::_ProcessBytes, CPeerSock::_ProcessMsg).
seq:
  - id: handshake
    type: handshake
  - id: messages
    type: message
    repeat: eos
types:
  handshake:
    seq:
      - id: protocol_len
        type: u1
        valid: 14
      - id: protocol
        type: str
        size: protocol_len
        encoding: ASCII
        valid: '"Swarm protocol"'
      - id: version
        type: u1
        doc: Reserved byte 0. Each side keeps the lower of the two versions.
      - id: reserved
        size: 7
        doc: Reserved bytes 1-7. Byte 5 (offset 4 here) is 0x10.
      - id: swarm_hash
        size: 32
        doc: HashOfHashes of the content's pieces hash file.
      - id: peer_id
        size: 20
  message:
    seq:
      - id: len
        type: u4
        valid:
          max: 0x1f4000
        doc: At most 0x1f4000. 0 is a keep-alive.
      - id: id
        type: u1
        enum: message_id
        if: len > 0
      - id: payload
        size: len - 1
        if: len > 0
        type:
          switch-on: id
          cases:
            'message_id::have': piece_index
            'message_id::bitfield': bitfield
            'message_id::request': block_ref
            'message_id::piece': block
            'message_id::cancel': block_ref
            'message_id::do_not_have': piece_index
  piece_index:
    -webide-representation: 'idx={index}'
    seq:
      - id: index
        type: u4
  bitfield:
    doc: Piece 0 is the high bit of byte 0.
    seq:
      - id: bits
        size-eos: true
  block_ref:
    -webide-representation: 'idx={index} begin={begin} len={length}'
    seq:
      - id: index
        type: u4
      - id: begin
        type: u4
      - id: length
        type: u4
  block:
    -webide-representation: 'idx={index} begin={begin} len={data.length}'
    seq:
      - id: index
        type: u4
      - id: begin
        type: u4
      - id: data
        size-eos: true
enums:
  message_id:
    0: choke
    1: unchoke
    2: interested
    3: not_interested
    4: have
    5: bitfield
    6: request
    7: piece
    8: cancel
    10: do_not_have
    20: extended
