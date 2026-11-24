// network/rtp_packet.ksy on UDP 5004, checked against Wireshark's own RTP dissector (decode-as udp.port==5004,rtp).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as h from '../helpers.ts';

const packets = [
  // V2, PT 0 (PCMU), seq 1, ts 160, 20 bytes of payload
  Buffer.from(`80000001000000a0deadbeef${'ff'.repeat(20)}`, 'hex'),
  // V2, padding, extension, marker, PT 96, seq 2, ts 320; a one-word header extension; 4 bytes of padding
  Buffer.from(`b0e0000200000140deadbeefbede000110ff0000${'aa'.repeat(8)}000004`, 'hex'),
];

describe('rtp_packet vs Wireshark rtp', { skip: h.skipFormats }, async () => {
  const lua = h.skipFormats ? '' : await h.generate('network/rtp_packet', { 'udp-port': 5004 });
  const run = (payloads: Buffer[], args?: string[]) =>
    h.dissect(args ? undefined : lua, h.pcap(payloads.map((p) => h.udp(40000, 5004, p))), args);

  test('fields match', () => {
    const [ours, theirs] = [run(packets), run(packets, ['-d', 'udp.port==5004,rtp'])];
    assert.deepEqual(h.problems(ours, 'rtp_packet'), []);
    h.assertSame(ours, theirs, 'rtp_packet', [
      ['version', 'rtp.version'],
      // one-bit flags, true and false
      ['has_padding', 'rtp.padding'],
      ['has_extension', 'rtp.ext'],
      ['marker', 'rtp.marker'],
      ['csrc_count', 'rtp.cc'],
      ['payload_type', 'rtp.p_type'],
      ['sequence_number', 'rtp.seq'],
      ['timestamp', 'rtp.timestamp'],
      ['ssrc', 'rtp.ssrc'],
      ['header_extention.id', 'rtp.ext.profile'],
      ['header_extention.length', 'rtp.ext.len'],
      // a `pos` instance at the end of the packet
      ['len_padding_if_exists', 'rtp.padding.count'],
    ]);
    // a bit-field enum shows the spec's label
    assert.deepEqual(
      ours.map((p) => h.one(p, 'rtp_packet.payload_type').showname),
      ['payload_type: pcmu (0)', 'payload_type: mpeg_ps (96)'],
    );
    // payload and padding split where the padding count says
    const ranges = (p: h.Packet, ...names: string[]) =>
      names.map((n) => h.one(p, `rtp_packet.${n}`)).map((f) => [f.pos, f.size]);
    assert.deepEqual(
      [...ranges(ours[0], 'data'), ...ranges(ours[1], 'data', 'padding')],
      [
        [54, 20],
        [58, 11],
        [69, 4],
      ],
    );
  });

  test('a header cut short is malformed', () => {
    const [p] = run([packets[0].subarray(0, 8)]);
    assert.equal(h.one(p, 'rtp_packet.timestamp').show, '160');
    assert.deepEqual([h.all(p, 'rtp_packet.malformed').length, h.all(p, '_ws.lua.error').length], [1, 0]);
  });
});
