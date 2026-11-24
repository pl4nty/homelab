// network/ethernet_frame.ksy (which imports ipv4_packet, ipv6_packet, protocol_body, tcp_segment, udp_datagram and
// icmp_packet; ipv6_packet and protocol_body import each other) as user DLT 0, checked against Wireshark's own
// eth/vlan/ip/ipv6/tcp/udp/icmp dissectors run over the same frames as plain Ethernet.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as h from '../helpers.ts';

const hex = (s: string) => Buffer.from(s, 'hex');
const http = h.tcp(51000, 80, Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n\r\n'), 0xdeadbeef, 0x01020304);
const vlanUdp = h.udp(40001, 40002, Buffer.from('vlan!'));
// traffic class 0xb8, flow label 0x12345, UDP, hop limit 255, 2001:db8::1 to 2001:db8::2
const ipv6 = hex(`6b812345000d11ff${'20010db80000000000000000000000'}01${'20010db80000000000000000000000'}02`);

const eth: h.Pair[] = [
  ['dst_mac', 'eth.dst'],
  ['src_mac', 'eth.src'],
  ['ether_type_1', 'eth.type'],
];
const ip: h.Pair[] = [
  ['ipv4_packet.version', 'ip.version', 'value'],
  ['ipv4_packet.ihl_bytes', 'ip.hdr_len', 'value'],
  ['ipv4_packet.total_length', 'ip.len'],
  ['ipv4_packet.identification', 'ip.id'],
  ['ipv4_packet.ttl', 'ip.ttl'],
  ['ipv4_packet.protocol', 'ip.proto'],
  ['ipv4_packet.header_checksum', 'ip.checksum'],
  ['ipv4_packet.src_ip_addr', 'ip.src', 'raw'],
  ['ipv4_packet.dst_ip_addr', 'ip.dst', 'raw'],
];
const udp: h.Pair[] = [
  ['udp_datagram.src_port', 'udp.srcport'],
  ['udp_datagram.dst_port', 'udp.dstport'],
  ['udp_datagram.length', 'udp.length'],
  ['udp_datagram.checksum', 'udp.checksum'],
  ['udp_datagram.body', 'udp.payload'],
];
const tcpFlags = 'cwr ece urg ack psh:push rst:reset syn fin';

// name, frame, the fields to compare
const frames: [string, Buffer, h.Pair[]][] = [
  [
    'tcp',
    http,
    [
      ...eth,
      ...ip,
      ['tcp_segment.src_port', 'tcp.srcport'],
      ['tcp_segment.dst_port', 'tcp.dstport'],
      ['tcp_segment.seq_num', 'tcp.seq_raw'],
      ['tcp_segment.ack_num', 'tcp.ack_raw'],
      ['tcp_segment.data_offset', 'tcp.hdr_len', (s) => Number(s) * 4],
      ['tcp_segment.window_size', 'tcp.window_size_value'],
      ['tcp_segment.checksum', 'tcp.checksum'],
      ['tcp_segment.body', 'tcp.payload'],
      // b1 fields, true or false
      ...tcpFlags
        .split(' ')
        .map((f): h.Pair => [`tcp_segment.flags.${f.split(':')[0]}`, `tcp.flags.${f.split(':').at(-1)}`]),
    ],
  ],
  [
    'vlan and udp',
    Buffer.concat([vlanUdp.subarray(0, 12), hex('8100a064'), vlanUdp.subarray(12)]), // PCP 5, VID 100
    // Wireshark's TCI fields each cover both bytes
    [
      ...eth,
      ['tag_control_info.priority', 'vlan.priority', 'value'],
      ['tag_control_info.vlan_id', 'vlan.id'],
      ['ether_type_2', 'vlan.etype'],
      ...ip,
      ...udp,
    ],
  ],
  [
    'icmp',
    h.ipv4(1, hex('0800f7fd000100026869')), // echo request, id 1, seq 2
    [
      ...eth,
      ...ip,
      ['icmp_packet.icmp_type', 'icmp.type'],
      ['icmp_packet.echo_msg.code', 'icmp.code', (s) => Number.parseInt(s, 16)],
      ['icmp_packet.echo_msg.checksum', 'icmp.checksum'],
      ['icmp_packet.echo_msg.identifier', 'icmp.ident'],
      ['icmp_packet.echo_msg.seq_num', 'icmp.seq'],
    ],
  ],
  [
    'ipv6 and udp',
    h.ethernet(Buffer.concat([ipv6, hex('9c419c42000d000068656c6c6f')]), 0x86dd),
    [
      ...eth,
      ['ipv6_packet.version', 'ipv6.version'],
      ['ipv6_packet.traffic_class', 'ipv6.tclass', 'value'],
      ['ipv6_packet.flow_label', 'ipv6.flow'],
      ['ipv6_packet.payload_length', 'ipv6.plen'],
      ['ipv6_packet.next_header_type', 'ipv6.nxt'],
      ['ipv6_packet.hop_limit', 'ipv6.hlim'],
      ['ipv6_packet.src_ipv6_addr', 'ipv6.src', 'raw'],
      ['ipv6_packet.dst_ipv6_addr', 'ipv6.dst', 'raw'],
      ...udp,
    ],
  ],
  ['truncated: the IPv4 header and 6 bytes of TCP', http.subarray(0, 40), [...eth, ...ip]],
];

describe('ethernet_frame (user DLT 0) vs Wireshark eth/ip/tcp/udp/icmp', { skip: h.skipFormats }, async () => {
  const lua = h.skipFormats ? '' : await h.generate('network/ethernet_frame', { 'user-dlt': 0 });
  const list = frames.map(([, frame]) => frame);
  const ours = h.skipFormats ? [] : h.dissect(lua, h.pcap(list, 147));
  const theirs = h.skipFormats ? [] : h.dissect(undefined, h.pcap(list));
  const field = (i: number, name: string) => h.one(ours[i], `ethernet_frame.${name}`);

  frames.forEach(([name, frame, pairs], i) => {
    test(`${name}: fields match`, () => {
      assert.equal(h.one(ours[i], 'ethernet_frame').size, frame.length);
      // only the truncated frame is malformed
      assert.equal(h.all(ours[i], 'ethernet_frame.malformed').length, name.startsWith('truncated') ? 1 : 0);
      assert.equal(h.all(ours[i], '_ws.lua.error').length + h.all(ours[i], 'ethernet_frame.instance').length, 0);
      h.assertSame([ours[i]], [theirs[i]], 'ethernet_frame', pairs);
    });
  });

  test('ranges and values Wireshark has no matching field for', () => {
    assert.equal(field(1, 'tag_control_info.drop_eligible').show, 'False');
    // the echo payload (icmp.data in Wireshark 4.6, data.data in 4.4) is the last 2 bytes
    const data = field(2, 'icmp_packet.echo_msg.data');
    assert.deepEqual([data.pos, data.size], [42, 2]);
    // a value instance has no byte range, and shows its enum's label
    for (const i of [0, 2, 3]) assert.equal(field(i, 'protocol_body.protocol').size, 0);
    assert.match(field(0, 'ether_type').showname, /ipv4/);
    assert.match(field(0, 'protocol_body.protocol').showname, /tcp/);
  });
});
