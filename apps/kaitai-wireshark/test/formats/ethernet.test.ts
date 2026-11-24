// network/ethernet_frame.ksy (which imports ipv4_packet, ipv6_packet, protocol_body, tcp_segment, udp_datagram and
// icmp_packet) as user DLT 0, checked against Wireshark's own eth/vlan/ip/ipv6/tcp/udp/icmp dissectors run over the
// same frames as plain Ethernet.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import * as h from './helpers.ts';

// ipv6_packet imports protocol_body, which imports ipv6_packet: the dissector's require() recurses until the stack
// overflows, so the script doesn't load at all

function vlan(ip: Buffer): Buffer {
  const e = h.ethernet(ip, { type: 0x8100 });
  return Buffer.concat([e.subarray(0, 14), Buffer.from([0xa0, 0x64, 0x08, 0x00]), e.subarray(14)]); // PCP 5, VID 100
}

function ipv6(next: number, payload: Buffer): Buffer {
  const x = Buffer.alloc(40);
  x.writeUInt32BE(((6 << 28) | (0xb8 << 20) | 0x12345) >>> 0); // traffic class 0xb8, flow label 0x12345
  x.writeUInt16BE(payload.length, 4);
  x[6] = next;
  x[7] = 255;
  Buffer.from('20010db8000000000000000000000001', 'hex').copy(x, 8);
  Buffer.from('20010db8000000000000000000000002', 'hex').copy(x, 24);
  return h.ethernet(Buffer.concat([x, payload]), { type: 0x86dd });
}

const http = h.ethernet(
  h.tcp(51000, 80, Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n\r\n'), { seq: 0xdeadbeef, ack: 0x01020304, flags: 0x18 }),
);
const frames = {
  tcp: http,
  vlanUdp: vlan(h.udp(40001, 40002, Buffer.from('vlan!'))),
  icmp: h.ethernet(h.ipv4(1, Buffer.from('0800f7fd000100026869', 'hex'))), // echo request, id 1, seq 2
  ipv6Udp: ipv6(17, Buffer.from('9c419c42000d000068656c6c6f', 'hex')),
  truncated: http.subarray(0, 40), // IPv4 header and 6 bytes of TCP
};
const order = Object.keys(frames) as (keyof typeof frames)[];

const ipv4Pairs: h.Pair[] = [
  { ours: 'ethernet_frame.ipv4_packet.version', theirs: 'ip.version', range: false },
  { ours: 'ethernet_frame.ipv4_packet.ihl_bytes', theirs: 'ip.hdr_len', range: false },
  { ours: 'ethernet_frame.ipv4_packet.total_length', theirs: 'ip.len' },
  { ours: 'ethernet_frame.ipv4_packet.identification', theirs: 'ip.id' },
  { ours: 'ethernet_frame.ipv4_packet.ttl', theirs: 'ip.ttl' },
  { ours: 'ethernet_frame.ipv4_packet.protocol', theirs: 'ip.proto' },
  { ours: 'ethernet_frame.ipv4_packet.header_checksum', theirs: 'ip.checksum' },
  { ours: 'ethernet_frame.ipv4_packet.src_ip_addr', theirs: 'ip.src', map: h.dotted },
  { ours: 'ethernet_frame.ipv4_packet.dst_ip_addr', theirs: 'ip.dst', map: h.dotted },
];
const udpPairs: h.Pair[] = [
  { ours: 'ethernet_frame.udp_datagram.src_port', theirs: 'udp.srcport' },
  { ours: 'ethernet_frame.udp_datagram.dst_port', theirs: 'udp.dstport' },
  { ours: 'ethernet_frame.udp_datagram.length', theirs: 'udp.length' },
  { ours: 'ethernet_frame.udp_datagram.checksum', theirs: 'udp.checksum' },
  { ours: 'ethernet_frame.udp_datagram.body', theirs: 'udp.payload' },
];
const ethPairs: h.Pair[] = [
  { ours: 'ethernet_frame.dst_mac', theirs: 'eth.dst' },
  { ours: 'ethernet_frame.src_mac', theirs: 'eth.src' },
  { ours: 'ethernet_frame.ether_type_1', theirs: 'eth.type' },
];

const pairs: Record<keyof typeof frames, h.Pair[]> = {
  tcp: [
    ...ethPairs,
    ...ipv4Pairs,
    { ours: 'ethernet_frame.tcp_segment.src_port', theirs: 'tcp.srcport' },
    { ours: 'ethernet_frame.tcp_segment.dst_port', theirs: 'tcp.dstport' },
    { ours: 'ethernet_frame.tcp_segment.seq_num', theirs: 'tcp.seq_raw' },
    { ours: 'ethernet_frame.tcp_segment.ack_num', theirs: 'tcp.ack_raw' },
    { ours: 'ethernet_frame.tcp_segment.data_offset', theirs: 'tcp.hdr_len', map: (s) => Number(s) * 4 },
    { ours: 'ethernet_frame.tcp_segment.window_size', theirs: 'tcp.window_size_value' },
    { ours: 'ethernet_frame.tcp_segment.checksum', theirs: 'tcp.checksum' },
    { ours: 'ethernet_frame.tcp_segment.body', theirs: 'tcp.payload' },
  ],
  vlanUdp: [
    ...ethPairs,
    // Wireshark's TCI fields each cover both bytes
    { ours: 'ethernet_frame.tag_control_info.priority', theirs: 'vlan.priority', range: false },
    { ours: 'ethernet_frame.tag_control_info.vlan_id', theirs: 'vlan.id' },
    { ours: 'ethernet_frame.ether_type_2', theirs: 'vlan.etype' },
    ...ipv4Pairs,
    ...udpPairs,
  ],
  icmp: [
    ...ethPairs,
    ...ipv4Pairs,
    { ours: 'ethernet_frame.icmp_packet.icmp_type', theirs: 'icmp.type' },
    { ours: 'ethernet_frame.icmp_packet.echo_msg.code', theirs: 'icmp.code', map: (s) => Number.parseInt(s, 16) },
    { ours: 'ethernet_frame.icmp_packet.echo_msg.checksum', theirs: 'icmp.checksum' },
    { ours: 'ethernet_frame.icmp_packet.echo_msg.identifier', theirs: 'icmp.ident' },
    { ours: 'ethernet_frame.icmp_packet.echo_msg.seq_num', theirs: 'icmp.seq' },
    // the echo payload is icmp.data in Wireshark 4.6 but data.data in 4.4, so it's checked on its own below
  ],
  ipv6Udp: [
    ...ethPairs,
    { ours: 'ethernet_frame.ipv6_packet.version', theirs: 'ipv6.version' },
    { ours: 'ethernet_frame.ipv6_packet.traffic_class', theirs: 'ipv6.tclass', range: false },
    { ours: 'ethernet_frame.ipv6_packet.flow_label', theirs: 'ipv6.flow' },
    { ours: 'ethernet_frame.ipv6_packet.payload_length', theirs: 'ipv6.plen' },
    { ours: 'ethernet_frame.ipv6_packet.next_header_type', theirs: 'ipv6.nxt' },
    { ours: 'ethernet_frame.ipv6_packet.hop_limit', theirs: 'ipv6.hlim' },
    { ours: 'ethernet_frame.ipv6_packet.src_ipv6_addr', theirs: 'ipv6.src', map: h.ipv6Text },
    { ours: 'ethernet_frame.ipv6_packet.dst_ipv6_addr', theirs: 'ipv6.dst', map: h.ipv6Text },
    ...udpPairs,
  ],
  truncated: [],
};

describe('ethernet_frame (user DLT 0) vs Wireshark eth/ip/tcp/udp/icmp', { skip: h.skip }, () => {
  let w: h.Workdir;
  let ours: h.Dissected;
  let theirs: h.Dissected;
  const packet = (d: h.Dissected, k: keyof typeof frames) => d.packets[order.indexOf(k)] ?? [];

  before(async () => {
    w = h.workdir();
    const { lua } = await h.dissectorFor('network/ethernet_frame', { 'user-dlt': 0 });
    w.write('eth.lua', lua);
    const list = order.map((k) => frames[k]);
    w.write('user0.pcap', h.pcap(list, h.LINKTYPE_USER0));
    w.write('ether.pcap', h.pcap(list, h.LINKTYPE_ETHERNET));
    ours = h.dissect(w, 'user0.pcap', { lua: 'eth.lua' });
    theirs = h.dissect(w, 'ether.pcap');
  });
  after(() => w?.remove());

  it('the dissector loads', () => {
    assert.doesNotMatch(ours.stderr, /Lua: Error during loading/);
    assert.equal(h.one(packet(ours, 'tcp'), 'ethernet_frame').size, frames.tcp.length);
  });

  for (const k of order.filter((k) => pairs[k].length > 0)) {
    it(`${k}: fields match`, () => {
      assert.deepEqual(h.problems({ packets: [packet(ours, k)], stderr: '' }, 'ethernet_frame'), []);
      const [a, b] = h.sideBySide([packet(ours, k)], [packet(theirs, k)], pairs[k]);
      assert.deepEqual(a, b);
    });
  }

  it('b1 flags are fields whether true or false', () => {
    const [a, b] = h.sideBySide(
      [packet(ours, 'tcp')],
      [packet(theirs, 'tcp')],
      ['cwr', 'ece', 'urg', 'ack', ['psh', 'push'], ['rst', 'reset'], 'syn', 'fin'].map((f) => {
        const [o, t] = Array.isArray(f) ? f : [f, f];
        return { ours: `ethernet_frame.tcp_segment.flags.${o}`, theirs: `tcp.flags.${t}` };
      }),
    );
    assert.deepEqual(a, b);
    const dei = h.one(packet(ours, 'vlanUdp'), 'ethernet_frame.tag_control_info.drop_eligible');
    assert.equal(dei.show, 'False');
  });

  it('icmp: the echo payload is its last 2 bytes', () => {
    const data = h.one(packet(ours, 'icmp'), 'ethernet_frame.icmp_packet.echo_msg.data');
    assert.deepEqual([data.pos, data.size], [42, 2]);
  });

  it('a value instance has no byte range', () => {
    for (const k of ['tcp', 'icmp', 'ipv6Udp'] as const) {
      const f = h.one(packet(ours, k), 'ethernet_frame.protocol_body.protocol');
      assert.equal(f.size, 0, `${k}: protocol_body.protocol at ${f.pos}+${f.size}`);
    }
  });

  it('a value instance with an enum shows its label', () => {
    assert.match(h.one(packet(ours, 'tcp'), 'ethernet_frame.ether_type').showname, /ipv4/);
    assert.match(h.one(packet(ours, 'tcp'), 'ethernet_frame.protocol_body.protocol').showname, /tcp/);
  });

  it('a truncated frame is malformed', () => {
    const p = packet(ours, 'truncated');
    assert.equal(h.all(p, 'ethernet_frame.malformed').length, 1);
    assert.equal(h.all(p, '_ws.lua.error').length, 0);
  });

  it('a truncated frame still shows the IPv4 header it read', () => {
    const [a, b] = h.sideBySide(
      [packet(ours, 'truncated')],
      [packet(theirs, 'truncated')],
      [...ethPairs, ...ipv4Pairs],
    );
    assert.deepEqual(a, b);
  });
});
