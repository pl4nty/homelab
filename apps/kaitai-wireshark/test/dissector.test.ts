// The generator against tshark, with the specs in test/fixtures.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { toLua } from '../src/index.ts';
import * as h from './helpers.ts';

const skip = h.skip;
const hex = (s: string) => Buffer.from(s.replaceAll(' ', ''), 'hex');
// tshark -T fields: a row of columns per packet
const fields = (lua: string, capture: string, names: string[], args: string[] = []) =>
  h
    .tshark(lua, ['-r', capture, ...args, '-T', 'fields', ...names.flatMap((n) => ['-e', n])])
    .trimEnd()
    .split('\n')
    .map((row) => row.split('\t'));

test('toLua', () => {
  const lua = toLua({ a: [1, 'x\n\u0001\\u', true, null], 16: 'n', 'b-c': {} });
  assert.equal(lua, '{[16] = "n", ["a"] = {1, "x\\n\\u{0001}\\\\u", true, nil}, ["b-c"] = {}}');
});

test('fields come from the spec: types, filter names, descriptions and enums', { skip }, async () => {
  const lua = await h.generate({
    meta: { id: 'top', endian: 'be', imports: ['sub'], '-wireshark': { 'udp-port': 9000 } },
    seq: [
      { id: 'a', type: 'u2le', enum: 'kind' },
      { id: 'b', type: 'b1' },
      { id: 'c', type: 'b12' },
      { id: 'd', type: 'strz', encoding: 'ASCII' },
      { id: 'e', size: 4, doc: 'Four bytes.\nMore.' },
      { id: 'f', type: 'inner(1)' },
      { id: 'g', type: { 'switch-on': 'a', cases: { 'kind::one': 'inner(2)', 'kind::sixteen': 'u4' } } },
      { id: 'h', type: { 'switch-on': 'a', cases: { 'kind::one': 'inner(2)', 'kind::sixteen': 'sub::thing' } } },
      { id: 'i', type: 'u1', enum: 'sub::color' },
      { type: 'f8' },
      { id: 'j', type: 's8' },
    ],
    instances: { v: { value: 'a.to_i * 2' } },
    enums: { kind: { 1: 'one', 16: { id: 'sixteen', doc: 'x' } } },
    types: { inner: { params: [{ id: 'p', type: 'u1' }], seq: [{ id: 'x', type: 's4', enum: 'kind' }] } },
  });
  // tshark -G fields: F, name, abbreviation, type, parent, base, bitmask, description
  const report = h.tshark(lua, ['-G', 'fields']).split('\n');
  const rows = report.map((row) => row.split('\t')).filter((row) => row[2]?.startsWith('top.'));
  assert.deepEqual(
    rows.map((r) => `${r[2].slice(4)}:${r[3].slice(3)}`).sort(),
    // a parameter (inner.p) isn't a field; a switch is a struct when all its cases are
    'a:UINT16 b:BOOLEAN c:UINT16 d:STRING e:BYTES f:NONE g:STRING h:NONE i:UINT8 _unnamed9:DOUBLE j:INT64 v:STRING'
      .concat(' inner.x:INT32 sub.v:UINT16 sub.thing.w:UINT8 malformed:NONE instance:NONE')
      .split(' ')
      .sort(),
  );
  assert.equal(rows.find((r) => r[2] === 'top.e')?.[7], 'Four bytes.');

  // a; b and c; d; e; f.x; g.x; h.x; i; the unnamed f8; j
  const payload = hex('0100 8028 7800 65656565 00000010 ffffffff 00000001 00 3ff8000000000000 fffffffffffffffe');
  const [p] = h.dissect(lua, h.pcap([h.udp(40000, 9000, payload)]));
  // nested types see the enclosing type's enums; an imported spec's enums resolve by its id
  assert.deepEqual(
    p.filter((f) => f.name.startsWith('top.')).map((f) => f.showname),
    'a: one (1)|b: True|c: 5|d: x|e: 65656565|f: sixteen|x: sixteen (16)|x: Unknown (-1)|h: one|x: one (1)'
      .concat('|i: red (0)|_unnamed9: 1.5|j: -2|v: 2')
      .split('|'),
  );
});

describe('TCP framing (DO peer protocol)', { skip }, async () => {
  // a copy, since tshark 4.4 in CI can't open the checked-out fixture ("You don't have permission")
  const file = h.write('pcap', readFileSync(`${h.FIXTURES}/do_peer.pcap`));
  const lua = skip ? '' : await h.generate('do_peer');
  // a capture of a 40 kB download, one PDU per segment (loopback, so nothing is split)
  const PDUS = [
    ...['handshake', 'handshake', 'interested', 'bitfield', 'unchoke'],
    ...['request idx=0 begin=0 len=16384', 'piece idx=0 begin=0 len=16384'],
    ...['request idx=0 begin=16384 len=16384', 'request idx=0 begin=32768 len=7232'],
    ...['piece idx=0 begin=16384 len=16384', 'piece idx=0 begin=32768 len=7232'],
  ].sort();
  const pdus = skip ? [] : h.tcpPayloads(file, 7680);
  // each direction as one write, so PDUs straddle segments and several end in one frame
  const streams = (['c', 's'] as const).map((from) => ({
    from,
    data: Buffer.concat(pdus.filter((p) => p.from === from).map((p) => p.data)),
  }));

  const captures: [string, h.Chunk[] | undefined, number, string[]][] = [
    ['as captured', undefined, 0, []],
    ['each PDU cut every 7 bytes', pdus, 7, []],
    ['each PDU cut every 3000 bytes', pdus, 3000, []],
    ['a stream cut every 7 bytes', streams, 7, []],
    ['a stream cut every 7 bytes, two passes', streams, 7, ['-2']],
    ['a stream cut every 100 bytes', streams, 100, []],
  ];
  for (const [name, chunks, mss, args] of captures) {
    test(name, () => {
      const capture = chunks ? h.pcap(h.conversation(chunks, 7680, mss)) : file;
      const rows = fields(lua, capture, ['_ws.col.info', '_ws.expert.message'], [...args, '-Y', 'do_peer']);
      assert.deepEqual(rows.flatMap(([info]) => info.split(', ')).sort(), PDUS);
      assert.equal(rows.map(([, expert]) => expert ?? '').join(''), '', 'no expert messages');
    });
  }

  test('a field in a substream has its range in the frame', () => {
    const [request] = h.dissect(lua, file, ['-Y', 'do_peer.message.id == 6']);
    // the request's begin is 9 bytes in: after the 4-byte len, 1-byte id and 4-byte index
    const [len, begin] = [h.one(request, 'do_peer.message.len'), h.one(request, 'do_peer.block_ref.begin')];
    assert.deepEqual([begin.pos - len.pos, begin.size, begin.show], [9, 4, '0']);
  });

  test('a terminated string split across segments', async () => {
    const meta = { id: 'line', '-wireshark': { 'tcp-port': 7000 } };
    const strz = await h.generate({ meta, seq: [{ id: 's', type: 'strz', encoding: 'ASCII' }] });
    const capture = h.pcap(h.conversation([{ from: 'c', data: Buffer.from('hello\0wireshark\0') }], 7000, 4));
    assert.deepEqual(fields(strz, capture, ['line.s'], ['-Y', 'line']), [['hello'], ['wireshark']]);
  });
});

describe('UDP (rich.ksy: bits, xor, imports, switch, instances)', { skip }, async () => {
  const lua = skip ? '' : await h.generate('rich');
  // magic; ver; flag=1 nib=1; name "hi"; blen; body.x = 1, xor 0x55; kind a => sub; sub.v; unnamed; rest
  const good = hex('5249 02 81 686900 0200 5455 01 002a 07 7461696c');
  const edit = (...bytes: [number, number][]) => {
    const b = Buffer.from(good);
    for (const [i, v] of bytes) b[i] = v;
    return b;
  };

  test('values', () => {
    const [p] = h.dissect(lua, h.pcap([h.udp(40000, 9999, good)]));
    const names = ['ver', 'flag', 'nib', 'name', 'body.x', 'kind', 'sub.v', '_unnamed9', 'rest', 'dbl', 'first'];
    const shown = names.map((n) => h.one(p, `rich.${n}`).show);
    assert.deepEqual(shown, ['2', 'True', '1', 'hi', '1', '1', '42', '7', '74:61:69:6c', '4', '82']);
    assert.equal(h.one(p, 'rich.kind').showname, 'kind: a (1)');
    // xor output is its own data source, so body.x is at its start
    const x = h.one(p, 'rich.body.x');
    assert.deepEqual([x.pos, x.size, x.value], [0, 2, '0100']);
  });

  // tshark -V: an expert item is the line under the item it marks
  const errors: [string, Buffer, RegExp][] = [
    ['a failed valid marks the field', edit([2, 9]), /ver: 9\n +\[Expert .*: ValidationGreaterThanError: ver = 9\]/],
    [
      'a failed valid in a nested type marks the field',
      edit([9, 0xaa], [10, 0xaa]),
      /x: 65535\n +\[Expert .*: ValidationGreaterThanError: x = 65535\]/,
    ],
    [
      'a failed instance is marked and the rest is dissected',
      edit([2, 3]),
      /\[far: past the end of the data\]\n +\[Expert Info \(Warning\/Malformed\): past the end(.|\n)*first: 82/,
    ],
    [
      'a truncated packet says where',
      good.subarray(0, 10),
      /\[Expert Info \(Error\/Malformed\): truncated.*\(after blen\)\]/,
    ],
  ];
  for (const [name, payload, expected] of errors) {
    test(name, () => {
      assert.match(h.tshark(lua, ['-r', h.pcap([h.udp(40000, 9999, payload)]), '-V', '-O', 'rich']), expected);
    });
  }
});

test('process: zlib decompresses with Wireshark and the result is dissected', { skip }, async () => {
  const z = deflateSync(Buffer.concat([Buffer.from('hello\0'), Buffer.from([0, 0, 1, 0])]));
  const capture = h.pcap([h.udp(40000, 9100, Buffer.concat([Buffer.from([0, z.length]), z]))]);
  const rows = fields(await h.generate('zpkt'), capture, ['zpkt.inner.greeting', 'zpkt.inner.n', '_ws.col.info']);
  assert.deepEqual(rows, [['hello', '256', 'hello n=256']]);
});
