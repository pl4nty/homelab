// network/dns_packet.ksy on UDP 53, checked against Wireshark's own DNS dissector.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import * as h from './helpers.ts';

const u16 = (...v: number[]) => Buffer.concat(v.map((x) => Buffer.from([x >> 8, x & 255])));
const u32 = (v: number) => Buffer.from([v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255]);
const labels = (...ls: string[]) =>
  Buffer.concat(ls.map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])));
const name = (s: string) => Buffer.concat([labels(...s.split('.')), Buffer.from([0])]);
const ptr = (off: number) => u16(0xc000 | off);
const rr = (owner: Buffer, type: number, ttl: number, rdata: Buffer) =>
  Buffer.concat([owner, u16(type, 1), u32(ttl), u16(rdata.length), rdata]);

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
const reply = { src: '192.0.2.2', dst: '192.0.2.1' };

describe('dns_packet vs Wireshark dns', { skip: h.skip }, () => {
  let w: h.Workdir;
  let ours: h.Dissected;
  let theirs: h.Dissected;

  before(async () => {
    w = h.workdir();
    const { lua } = await h.dissectorFor('network/dns_packet', { 'udp-port': 53 });
    w.write('dns.lua', lua);
    w.write('dns.pcap', h.pcap([h.ethernet(h.udp(40000, 53, query)), h.ethernet(h.udp(53, 40000, response, reply))]));
    ours = h.dissect(w, 'dns.pcap', { lua: 'dns.lua' });
    theirs = h.dissect(w, 'dns.pcap');
  });
  after(() => w?.remove());

  it('dissects both packets without a Lua error', () => {
    assert.deepEqual(h.problems(ours, 'dns_packet'), []);
  });

  it('header fields match', () => {
    const [a, b] = h.sideBySide(ours.packets, theirs.packets, [
      { ours: 'dns_packet.transaction_id', theirs: 'dns.id' },
      { ours: 'dns_packet.packet_flags.flag', theirs: 'dns.flags' },
      { ours: 'dns_packet.qdcount', theirs: 'dns.count.queries' },
      { ours: 'dns_packet.ancount', theirs: 'dns.count.answers' },
      { ours: 'dns_packet.nscount', theirs: 'dns.count.auth_rr' },
      { ours: 'dns_packet.arcount', theirs: 'dns.count.add_rr' },
    ]);
    assert.deepEqual(a, b);
  });

  it('flag value instances match the flag bits', () => {
    // Wireshark only shows aa, ra, ad and rcode in responses
    const [a, b] = h.sideBySide(
      ours.packets.slice(1),
      theirs.packets.slice(1),
      [
        ['qr', 'response'],
        ['opcode', 'opcode'],
        ['aa', 'authoritative'],
        ['tc', 'truncated'],
        ['rd', 'recdesired'],
        ['ra', 'recavail'],
        ['z', 'z'],
        ['ad', 'authenticated'],
        ['cd', 'checkdisable'],
        ['rcode', 'rcode'],
      ].map(([o, t]) => ({ ours: `dns_packet.packet_flags.${o}`, theirs: `dns.flags.${t}`, range: false })),
    );
    assert.deepEqual(a, b);
  });

  it('question and resource records match', () => {
    const [a, b] = h.sideBySide(ours.packets, theirs.packets, [
      { ours: 'dns_packet.query.name', theirs: 'dns.qry.name', value: false },
      { ours: 'dns_packet.query.type', theirs: 'dns.qry.type' },
      { ours: 'dns_packet.query.query_class', theirs: 'dns.qry.class' },
      { ours: 'dns_packet.answer.name', theirs: 'dns.resp.name', value: false },
      { ours: 'dns_packet.answer.type', theirs: 'dns.resp.type' },
      { ours: 'dns_packet.answer.answer_class', theirs: 'dns.resp.class' },
      { ours: 'dns_packet.answer.ttl', theirs: 'dns.resp.ttl' },
      { ours: 'dns_packet.answer.rdlength', theirs: 'dns.resp.len' },
      { ours: 'dns_packet.address.ip', theirs: 'dns.a', map: h.dotted },
      { ours: 'dns_packet.address_v6.ip_v6', theirs: 'dns.aaaa', map: h.ipv6Text },
      { ours: 'dns_packet.mx_info.preference', theirs: 'dns.mx.preference' },
    ]);
    assert.deepEqual(a, b);
  });

  it('enum labels come from the spec', () => {
    const types = ours.packets.flatMap((p) => h.all(p, 'dns_packet.answer.type').map((f) => f.showname));
    assert.deepEqual(types, ['type: cname (5)', 'type: a (1)', 'type: aaaa (28)', 'type: ns (2)', 'type: mx (15)']);
  });

  it('compressed names resolve to the names Wireshark shows', () => {
    // a name's labels, through any pointers, are the label.name fields under it in tree order
    const spell = (p: h.PField[], f: h.PField) =>
      h
        .subtree(p, f)
        .filter((x) => x.name === 'dns_packet.label.name' && x.show !== '')
        .map((x) => x.show)
        .join('.');
    const names = (p: h.PField[], fields: string[]) =>
      p.filter((f) => fields.includes(f.name)).map((f) => (f.name.startsWith('dns.') ? f.show : spell(p, f)));
    const resp = ours.packets[1];
    const ourNames = names(resp, ['dns_packet.query.name', 'dns_packet.answer.name']);
    const ourData = h
      .all(resp, 'dns_packet.answer.payload')
      .map((f) => h.subtree(resp, f).find((x) => x.name === 'dns_packet.mx_info.mx' || x.name === '_ws.lua.text'))
      .filter((f): f is h.PField => f !== undefined && /name|mx/.test(f.showname))
      .map((f) => spell(resp, f));
    assert.deepEqual(ourNames, names(theirs.packets[1], ['dns.qry.name', 'dns.resp.name']));
    assert.deepEqual(ourData, names(theirs.packets[1], ['dns.cname', 'dns.ns', 'dns.mx.mail_exchange']));
  });
});

describe('dns_packet on bad packets', { skip: h.skip }, () => {
  let w: h.Workdir;
  let lua: string;
  before(async () => {
    w = h.workdir();
    lua = (await h.dissectorFor('network/dns_packet', { 'udp-port': 53 })).lua;
    w.write('dns.lua', lua);
  });
  after(() => w?.remove());

  const run = (file: string, payload: Buffer) => {
    w.write(file, h.pcap([h.ethernet(h.udp(40000, 53, payload))]));
    return h.dissect(w, file, { lua: 'dns.lua', timeout: 20 });
  };

  it('a truncated query is malformed, after the header it could read', () => {
    const d = run('short.pcap', query.subarray(0, 25)); // cut inside the question's name
    const p = d.packets[0];
    assert.equal(h.one(p, 'dns_packet.qdcount').show, '1');
    assert.ok(h.all(p, 'dns_packet.malformed').length === 1, 'a Malformed expert item');
    assert.equal(h.all(p, '_ws.lua.error').length, 0);
  });

  it('a truncated query still shows the labels it read', () => {
    const p = run('short2.pcap', query.subarray(0, 25)).packets[0];
    assert.deepEqual(
      h.all(p, 'dns_packet.label.name').map((f) => f.show),
      ['www', 'example'],
    );
  });

  it('a pointer past the end shows the instance error as text', () => {
    const p = run('far.pcap', Buffer.concat([u16(0x2222, 0x0100, 1, 0, 0, 0), ptr(0xff), u16(1, 1)])).packets[0];
    assert.ok(h.all(p, 'dns_packet.instance').length === 1, 'an instance expert item');
    const text = p.find((f) => f.name === '_ws.lua.text' && f.showname.startsWith('contents:'));
    assert.equal(text?.showname, 'contents: past the end of the data');
  });

  it('a name that points at itself does not hang', () => {
    const d = run('loop.pcap', Buffer.concat([u16(0x1111, 0x0100, 1, 0, 0, 0), ptr(12), u16(1, 1)]));
    assert.equal(d.packets.length, 1);
  });
});
