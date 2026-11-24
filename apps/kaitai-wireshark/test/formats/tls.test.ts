// network/tls_client_hello.ksy over TCP 443, checked against Wireshark's own TLS dissector. The spec is only the
// ClientHello body, so a small wrapper spec (record and handshake headers) imports it; records are the PDUs, and
// tests split them across TCP segments to exercise reassembly.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import * as h from './helpers.ts';

const wrapper = {
  meta: { id: 'tls_record', endian: 'be', imports: ['/network/tls_client_hello'] },
  seq: [{ id: 'records', type: 'record', repeat: 'eos' }],
  types: {
    record: {
      seq: [
        { id: 'content_type', type: 'u1' },
        { id: 'version', type: 'u2' },
        { id: 'length', type: 'u2' },
        { id: 'fragment', size: 'length', type: 'handshake' },
      ],
    },
    handshake: {
      seq: [
        { id: 'msg_type', type: 'u1' },
        { id: 'length', type: 'b24' },
        { id: 'body', size: 'length', type: 'tls_client_hello' },
      ],
    },
  },
};

const u16 = (v: number) => Buffer.from([v >> 8, v & 255]);
const vec16 = (b: Buffer) => Buffer.concat([u16(b.length), b]);
function clientHello(host: string): Buffer {
  const sni = Buffer.concat([u16(0), vec16(vec16(Buffer.concat([Buffer.from([0]), vec16(Buffer.from(host))])))]);
  const alpn = Buffer.concat([u16(16), vec16(vec16(Buffer.from('\x02h2\x08http/1.1', 'latin1')))]);
  const body = Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32, 0x11), // random
    Buffer.from([32]),
    Buffer.alloc(32, 0x22), // session id
    vec16(Buffer.from('130113021303c02bc02f', 'hex')),
    Buffer.from([1, 0]), // compression: null
    vec16(Buffer.concat([sni, alpn])),
  ]);
  const hs = Buffer.concat([Buffer.from([1, 0, body.length >> 8, body.length & 255]), body]);
  return Buffer.concat([Buffer.from([22, 3, 1]), u16(hs.length), hs]);
}

// one TCP direction, the payload cut at the given offsets
function stream(sport: number, payload: Buffer, cuts: number[]): Buffer[] {
  const bounds = [0, ...cuts, payload.length];
  return bounds
    .slice(1)
    .map((end, i) =>
      h.ethernet(h.tcp(sport, 443, payload.subarray(bounds[i], end), { seq: 1000 + bounds[i], ack: 1 })),
    );
}

const a = clientHello('example.com');
const b = clientHello('b.example.org');
const frames = [
  ...stream(50000, a, [60]), // frames 1-2: one record in two segments
  ...stream(50001, Buffer.concat([a, b]), []), // frame 3: two records in one segment
  ...stream(50002, b, [7, 100]), // frames 4-6: split inside the b24 handshake length, then in the extensions
];

const pairs: h.Pair[] = [
  { ours: 'tls_record.record.content_type', theirs: 'tls.record.content_type' },
  { ours: 'tls_record.record.version', theirs: 'tls.record.version' },
  { ours: 'tls_record.record.length', theirs: 'tls.record.length' },
  { ours: 'tls_record.handshake.msg_type', theirs: 'tls.handshake.type' },
  { ours: 'tls_record.handshake.length', theirs: 'tls.handshake.length' },
  { ours: 'tls_record.tls_client_hello.version', theirs: 'tls.handshake.version', value: false },
  { ours: 'tls_record.tls_client_hello.random.gmt_unix_time', theirs: 'tls.handshake.random_time', value: false },
  { ours: 'tls_record.tls_client_hello.random.random', theirs: 'tls.handshake.random_bytes' },
  { ours: 'tls_record.tls_client_hello.session_id.len', theirs: 'tls.handshake.session_id_length' },
  { ours: 'tls_record.tls_client_hello.session_id.sid', theirs: 'tls.handshake.session_id' },
  { ours: 'tls_record.tls_client_hello.cipher_suites.len', theirs: 'tls.handshake.cipher_suites_length' },
  { ours: 'tls_record.tls_client_hello.cipher_suites.cipher_suites', theirs: 'tls.handshake.ciphersuite' },
  { ours: 'tls_record.tls_client_hello.compression_methods.len', theirs: 'tls.handshake.comp_methods_length' },
  {
    ours: 'tls_record.tls_client_hello.compression_methods.compression_methods',
    theirs: 'tls.handshake.comp_methods',
    value: false,
  },
];
const extensionPairs: h.Pair[] = [
  { ours: 'tls_record.tls_client_hello.extensions.len', theirs: 'tls.handshake.extensions_length' },
  { ours: 'tls_record.tls_client_hello.extension.type', theirs: 'tls.handshake.extension.type' },
  { ours: 'tls_record.tls_client_hello.extension.len', theirs: 'tls.handshake.extension.len' },
  { ours: 'tls_record.tls_client_hello.sni.list_length', theirs: 'tls.handshake.extensions_server_name_list_len' },
  { ours: 'tls_record.tls_client_hello.server_name.name_type', theirs: 'tls.handshake.extensions_server_name_type' },
  { ours: 'tls_record.tls_client_hello.server_name.length', theirs: 'tls.handshake.extensions_server_name_len' },
  {
    ours: 'tls_record.tls_client_hello.server_name.host_name',
    theirs: 'tls.handshake.extensions_server_name',
    map: h.ascii,
  },
  { ours: 'tls_record.tls_client_hello.alpn.ext_len', theirs: 'tls.handshake.extensions_alpn_len' },
  { ours: 'tls_record.tls_client_hello.protocol.strlen', theirs: 'tls.handshake.extensions_alpn_str_len' },
  { ours: 'tls_record.tls_client_hello.protocol.name', theirs: 'tls.handshake.extensions_alpn_str', map: h.ascii },
];

describe('tls_client_hello (in a record wrapper) vs Wireshark tls', { skip: h.skip }, () => {
  let w: h.Workdir;
  let ours: h.Dissected;
  let theirs: h.Dissected;

  before(async () => {
    w = h.workdir();
    const { lua } = await h.dissectorFor(wrapper, { 'tcp-port': 443, pdu: 'record' });
    w.write('tls.lua', lua);
    w.write('tls.pcap', h.pcap(frames));
    ours = h.dissect(w, 'tls.pcap', { lua: 'tls.lua' });
    theirs = h.dissect(w, 'tls.pcap');
  });
  after(() => w?.remove());

  it('dissects without errors', () => {
    assert.deepEqual(h.problems(ours, 'tls_record'), []);
  });

  it('reassembles each record in the frame Wireshark does', () => {
    const count = (d: h.Dissected, name: string) => d.packets.map((p) => h.all(p, name).length);
    assert.deepEqual(count(ours, 'tls_record.record.content_type'), count(theirs, 'tls.record.content_type'));
    assert.deepEqual(count(ours, 'tls_record.record.content_type'), [0, 1, 2, 0, 0, 1]);
  });

  it('a record split across two or three segments reassembles, and its header fields match', () => {
    // frames 1-2 and 4-6 carry one record each
    const pick = (d: h.Dissected) => d.packets.filter((_, i) => i !== 2);
    const [x, y] = h.sideBySide(pick(ours), pick(theirs), pairs);
    assert.deepEqual(x, y);
  });

  it('record, handshake and hello fields match', () => {
    const [x, y] = h.sideBySide(ours.packets, theirs.packets, pairs);
    assert.deepEqual(x, y);
  });

  it('extensions match', () => {
    const [x, y] = h.sideBySide(ours.packets, theirs.packets, extensionPairs);
    assert.deepEqual(x, y);
  });

  it('an array spans all its elements', () => {
    const arrays = (d: h.Dissected, pick: (f: h.PField) => boolean) =>
      d.packets.flatMap((p) => p.filter(pick).map((f) => [f.pos, f.size]));
    assert.deepEqual(
      arrays(ours, (f) => f.name === '_ws.lua.text' && f.showname.startsWith('cipher_suites (')),
      arrays(theirs, (f) => f.name === 'tls.handshake.ciphersuites'),
    );
    assert.deepEqual(
      arrays(ours, (f) => f.name === '_ws.lua.text' && f.showname.startsWith('alpn_protocols (')),
      arrays(theirs, (f) => f.name === 'tls.handshake.extensions_alpn_list'),
    );
  });
});
