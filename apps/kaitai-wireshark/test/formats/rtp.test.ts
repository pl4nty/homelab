// network/rtp_packet.ksy on UDP 5004, checked against Wireshark's own RTP dissector (decode-as udp.port==5004,rtp).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import * as h from './helpers.ts';

const packets = [
  // V2, PT 0 (PCMU), seq 1, ts 160, 20 bytes of payload
  Buffer.from(`80000001000000a0deadbeef${'ff'.repeat(20)}`, 'hex'),
  // V2, padding, extension, marker, PT 96, seq 2, ts 320; a one-word header extension; 4 bytes of padding
  Buffer.from(`b0e0000200000140deadbeefbede000110ff0000${'aa'.repeat(8)}000004`, 'hex'),
];

const bits = ['has_padding', 'has_extension', 'marker'];

const pairs: h.Pair[] = [
  { ours: 'rtp_packet.version', theirs: 'rtp.version' },
  { ours: 'rtp_packet.has_padding', theirs: 'rtp.padding' },
  { ours: 'rtp_packet.has_extension', theirs: 'rtp.ext' },
  { ours: 'rtp_packet.csrc_count', theirs: 'rtp.cc' },
  { ours: 'rtp_packet.marker', theirs: 'rtp.marker' },
  { ours: 'rtp_packet.payload_type', theirs: 'rtp.p_type' },
  { ours: 'rtp_packet.sequence_number', theirs: 'rtp.seq' },
  { ours: 'rtp_packet.timestamp', theirs: 'rtp.timestamp' },
  { ours: 'rtp_packet.ssrc', theirs: 'rtp.ssrc' },
  { ours: 'rtp_packet.header_extention.id', theirs: 'rtp.ext.profile' },
  { ours: 'rtp_packet.header_extention.length', theirs: 'rtp.ext.len' },
  // a `pos` instance at the end of the packet
  { ours: 'rtp_packet.len_padding_if_exists', theirs: 'rtp.padding.count' },
];

describe('rtp_packet vs Wireshark rtp', { skip: h.skip }, () => {
  let w: h.Workdir;
  let ours: h.Dissected;
  let theirs: h.Dissected;

  before(async () => {
    w = h.workdir();
    const { lua } = await h.dissectorFor('network/rtp_packet', { 'udp-port': 5004 });
    w.write('rtp.lua', lua);
    w.write('rtp.pcap', h.pcap(packets.map((p, i) => h.ethernet(h.udp(40000, 5004, p, { id: i })))));
    w.write('short.pcap', h.pcap([h.ethernet(h.udp(40000, 5004, packets[0].subarray(0, 8)))]));
    ours = h.dissect(w, 'rtp.pcap', { lua: 'rtp.lua' });
    theirs = h.dissect(w, 'rtp.pcap', { args: ['-d', 'udp.port==5004,rtp'] });
  });
  after(() => w?.remove());

  it('dissects without errors', () => {
    assert.deepEqual(h.problems(ours, 'rtp_packet'), []);
  });

  it('header fields match', () => {
    const [a, b] = h.sideBySide(
      ours.packets,
      theirs.packets,
      pairs.filter((p) => !bits.some((b) => p.ours.endsWith(b))),
    );
    assert.deepEqual(a, b);
  });

  it('one-bit flags match, false ones too', () => {
    const [a, b] = h.sideBySide(
      ours.packets,
      theirs.packets,
      pairs.filter((p) => bits.some((b) => p.ours.endsWith(b))),
    );
    assert.deepEqual(a, b);
  });

  it('a bit-field enum shows the spec label', () => {
    assert.deepEqual(
      ours.packets.map((p) => h.one(p, 'rtp_packet.payload_type').showname),
      ['payload_type: pcmu (0)', 'payload_type: mpeg_ps (96)'],
    );
  });

  it('payload and padding split where the padding count says', () => {
    const [p1, p2] = ours.packets;
    assert.deepEqual(
      [h.one(p1, 'rtp_packet.data'), h.one(p2, 'rtp_packet.data'), h.one(p2, 'rtp_packet.padding')].map((f) => [
        f.pos,
        f.size,
      ]),
      [
        [54, 20],
        [58, 11],
        [69, 4],
      ],
    );
    assert.equal(h.one(p2, 'rtp_packet.len_padding').show, '4');
  });

  it('a header cut short is malformed', () => {
    const d = h.dissect(w, 'short.pcap', { lua: 'rtp.lua' });
    const p = d.packets[0];
    assert.equal(h.one(p, 'rtp_packet.timestamp').show, '160');
    assert.equal(h.all(p, 'rtp_packet.malformed').length, 1);
    assert.equal(h.all(p, '_ws.lua.error').length, 0);
  });
});
