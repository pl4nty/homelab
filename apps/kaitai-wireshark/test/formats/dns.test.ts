// network/dns_packet.ksy on UDP 53, checked against Wireshark's own DNS dissector.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as h from '../helpers.ts';

const u16 = (...v: number[]) => Buffer.concat(v.map((x) => Buffer.from([x >> 8, x & 255])));
const labels = (...ls: string[]) => Buffer.concat(ls.map((l) => Buffer.from([l.length, ...Buffer.from(l)])));
const name = (s: string) => Buffer.concat([labels(...s.split('.')), Buffer.from([0])]);
const ptr = (off: number) => u16(0xc000 | off);
const rr = (owner: Buffer, type: number, ttl: number, rdata: Buffer) =>
  Buffer.concat([owner, u16(type, 1, 0, ttl, rdata.length), rdata]);

const query = Buffer.concat([u16(0xbeef, 0x0100, 1, 0, 0, 0), name('www.example.com'), u16(1, 1)]);
// www.example.com is at offset 12, example.com at 16; every later name is compressed against them
const cdn = Buffer.concat([labels('cdn'), ptr(16)]);
const response = Buffer.concat([
  u16(0xbeef, 0x8180, 1, 3, 1, 1),
  name('www.example.com'),
  u16(1, 1),
  rr(ptr(12), 5, 300, cdn), // CNAME
  rr(cdn, 1, 60, Buffer.from([93, 184, 216, 34])), // A, owner name partly compressed
  rr(ptr(16), 28, 60, Buffer.from('20010db8000000000000000000000001', 'hex')), // AAAA
  rr(ptr(16), 2, 3600, Buffer.concat([labels('ns'), ptr(16)])), // NS (authority)
  rr(ptr(16), 15, 3600, Buffer.concat([u16(10), labels('mail'), ptr(16)])), // MX (additional)
]);

describe('dns_packet vs Wireshark dns', { skip: h.skipFormats }, async () => {
  const lua = h.skipFormats ? '' : await h.generate('network/dns_packet', { 'udp-port': 53 });
  const run = (...payloads: Buffer[]) => h.dissect(lua, h.pcap(payloads.map((p) => h.udp(40000, 53, p))));

  test('fields match', () => {
    const capture = h.pcap([h.udp(40000, 53, query), h.udp(53, 40000, response, 2)]);
    const [ours, theirs] = [h.dissect(lua, capture), h.dissect(undefined, capture)];
    assert.deepEqual(h.problems(ours, 'dns_packet'), []);
    h.assertSame(ours, theirs, 'dns_packet', [
      ['transaction_id', 'dns.id'],
      ['packet_flags.flag', 'dns.flags'],
      ['qdcount', 'dns.count.queries'],
      ['ancount', 'dns.count.answers'],
      ['nscount', 'dns.count.auth_rr'],
      ['arcount', 'dns.count.add_rr'],
      ['query.name', 'dns.qry.name', 'range'],
      ['query.type', 'dns.qry.type'],
      ['query.query_class', 'dns.qry.class'],
      ['answer.name', 'dns.resp.name', 'range'],
      ['answer.type', 'dns.resp.type'],
      ['answer.answer_class', 'dns.resp.class'],
      ['answer.ttl', 'dns.resp.ttl'],
      ['answer.rdlength', 'dns.resp.len'],
      ['address.ip', 'dns.a', 'raw'],
      ['address_v6.ip_v6', 'dns.aaaa', 'raw'],
      ['mx_info.preference', 'dns.mx.preference'],
    ]);
    // value instances over the flag bits; Wireshark only shows aa, ra, ad and rcode in responses
    const flags =
      'qr:response opcode aa:authoritative tc:truncated rd:recdesired ra:recavail z ad:authenticated cd:checkdisable rcode';
    h.assertSame(
      ours.slice(1),
      theirs.slice(1),
      'dns_packet.packet_flags',
      flags.split(' ').map((f) => [f.split(':')[0], `dns.flags.${f.split(':').at(-1)}`, 'value']),
    );
    // enum labels come from the spec
    assert.deepEqual(
      h.all(ours[1], 'dns_packet.answer.type').map((f) => f.showname),
      ['type: cname (5)', 'type: a (1)', 'type: aaaa (28)', 'type: ns (2)', 'type: mx (15)'],
    );

    // compressed names: a name's labels, through any pointers (`pos` instances), are the label.name fields under it
    const spell = (f: h.Field) =>
      h
        .subtree(ours[1], f)
        .filter((x) => x.name === 'dns_packet.label.name' && x.show !== '')
        .map((x) => x.show)
        .join('.');
    const shown = (p: h.Packet, names: string[]) => p.filter((f) => names.includes(f.name));
    assert.deepEqual(
      shown(ours[1], ['dns_packet.query.name', 'dns_packet.answer.name']).map(spell),
      shown(theirs[1], ['dns.qry.name', 'dns.resp.name']).map((f) => f.show),
    );
  });

  const u = (p: h.Packet, n: string) => h.all(p, `dns_packet.${n}`);
  test('a truncated query is malformed, and shows what it read', () => {
    const [p] = run(query.subarray(0, 25)); // cut inside the question's name
    assert.deepEqual([u(p, 'malformed').length, h.all(p, '_ws.lua.error').length], [1, 0]);
    assert.deepEqual(
      [...u(p, 'qdcount'), ...u(p, 'label.name')].map((f) => f.show),
      ['1', 'www', 'example'],
    );
  });

  test('a pointer past the end is a failed instance; one that points at itself does not hang', () => {
    const [far, loop] = run(
      ...[0xff, 12].map((to) => Buffer.concat([u16(0x2222, 0x0100, 1, 0, 0, 0), ptr(to), u16(1, 1)])),
    );
    assert.equal(u(far, 'instance').length, 1);
    assert.ok(far.some((f) => f.showname === 'contents: past the end of the data'));
    assert.equal(u(loop, 'qdcount')[0].show, '1');
  });
});
