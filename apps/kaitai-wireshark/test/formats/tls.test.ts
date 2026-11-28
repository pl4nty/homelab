// network/tls_client_hello.ksy over TCP 443, checked against Wireshark's own TLS dissector. The spec is only the
// ClientHello body, so a small wrapper spec (record and handshake headers) imports it; records are the PDUs, and
// are split across TCP segments to exercise reassembly.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as h from '../helpers.ts';

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
function stream(sport: number, payload: Buffer, ...cuts: number[]): Buffer[] {
  const bounds = [0, ...cuts, payload.length];
  return bounds.slice(1).map((end, i) => h.tcp(sport, 443, payload.subarray(bounds[i], end), 1000 + bounds[i]));
}

const [a, b] = [clientHello('example.com'), clientHello('b.example.org')];
const frames = [
  ...stream(50000, a, 60), // frames 1-2: one record in two segments
  ...stream(50001, Buffer.concat([a, b])), // frame 3: two records in one segment
  ...stream(50002, b, 7, 100), // frames 4-6: split inside the b24 handshake length, then in the extensions
];

const hello = (pairs: [string, string, h.Pair[2]?][]) =>
  pairs.map(([o, t, how]): h.Pair => [`tls_client_hello.${o}`, `tls.handshake.${t}`, how]);

describe('tls_client_hello (in a record wrapper) vs Wireshark tls', { skip: h.skipFormats }, async () => {
  const capture = h.skipFormats ? '' : h.pcap(frames);
  const ours = h.skipFormats ? [] : h.dissect(await h.generate(wrapper, { 'tcp-port': 443, pdu: 'record' }), capture);
  const theirs = h.skipFormats ? [] : h.dissect(undefined, capture);

  test('each record reassembles in the frame Wireshark reassembles it in', () => {
    assert.deepEqual(h.problems(ours, 'tls_record'), []);
    const count = (packets: h.Packet[], name: string) => packets.map((p) => h.all(p, name).length);
    assert.deepEqual(count(ours, 'tls_record.record.content_type'), [0, 1, 2, 0, 0, 1]);
    assert.deepEqual(count(theirs, 'tls.record.content_type'), [0, 1, 2, 0, 0, 1]);
  });

  test('fields match', () => {
    h.assertSame(ours, theirs, 'tls_record', [
      ['record.content_type', 'tls.record.content_type'],
      ['record.version', 'tls.record.version'],
      ['record.length', 'tls.record.length'],
      ['handshake.msg_type', 'tls.handshake.type'],
      ['handshake.length', 'tls.handshake.length'],
      ...hello([
        ['version', 'version', 'range'],
        ['random.gmt_unix_time', 'random_time', 'range'],
        ['random.random', 'random_bytes'],
        ['session_id.len', 'session_id_length'],
        ['session_id.sid', 'session_id'],
        ['cipher_suites.len', 'cipher_suites_length'],
        ['cipher_suites.cipher_suites', 'ciphersuite'],
        ['compression_methods.len', 'comp_methods_length'],
        ['compression_methods.compression_methods', 'comp_methods', 'range'],
        ['extensions.len', 'extensions_length'],
        ['extension.type', 'extension.type'],
        ['extension.len', 'extension.len'],
        ['sni.list_length', 'extensions_server_name_list_len'],
        ['server_name.name_type', 'extensions_server_name_type'],
        ['server_name.length', 'extensions_server_name_len'],
        ['server_name.host_name', 'extensions_server_name', 'raw'],
        ['alpn.ext_len', 'extensions_alpn_len'],
        ['protocol.strlen', 'extensions_alpn_str_len'],
        ['protocol.name', 'extensions_alpn_str', 'raw'],
      ]),
    ]);
  });

  test('an array spans all its elements', () => {
    const ranges = (packets: h.Packet[], pick: (f: h.Field) => boolean) =>
      packets.flatMap((p) => p.filter(pick).map((f) => [f.pos, f.size]));
    for (const [array, theirName] of [
      ['cipher_suites', 'ciphersuites'],
      ['alpn_protocols', 'extensions_alpn_list'],
    ]) {
      assert.deepEqual(
        ranges(ours, (f) => f.name === '_ws.lua.text' && f.showname.startsWith(`${array} (`)),
        ranges(theirs, (f) => f.name === `tls.handshake.${theirName}`),
      );
    }
  });
});
