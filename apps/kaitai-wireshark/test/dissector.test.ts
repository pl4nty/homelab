import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { fields, fixtures, pcap, tcp, tcpPayloads, tshark, tsharkMissing, udp } from './helpers.ts';

const skip = tsharkMissing;
const doPeer = `${fixtures}do_peer.ksy`;
const doPeerPcap = `${fixtures}do_peer.pcap`;

// A capture of a 40 kB download, one PDU per message (loopback, so nothing is split)
const DO_PEER_PDUS = [
  'handshake',
  'handshake',
  'interested',
  'bitfield',
  'unchoke',
  'request idx=0 begin=0 len=16384',
  'piece idx=0 begin=0 len=16384',
  'request idx=0 begin=16384 len=16384',
  'request idx=0 begin=32768 len=7232',
  'piece idx=0 begin=16384 len=16384',
  'piece idx=0 begin=32768 len=7232',
];

async function pdus(capture: Uint8Array | string) {
  const rows = await fields(doPeer, capture, ['_ws.col.info'], 'do_peer');
  return rows.flatMap(([info]) => info.split(', '));
}

describe('TCP framing (DO peer protocol)', { skip }, () => {
  test('one PDU per segment', async () => {
    assert.deepEqual(await pdus(doPeerPcap), DO_PEER_PDUS);
  });

  for (const mss of [7, 100, 3000, 65000]) {
    test(`resegmented at ${mss} bytes`, async () => {
      const capture = pcap(tcp(tcpPayloads(doPeerPcap, 7680), 7680, mss));
      assert.deepEqual(await pdus(capture), DO_PEER_PDUS);
    });
  }

  test('field ranges', async () => {
    const out = JSON.parse(await tshark(doPeer, doPeerPcap, ['-Y', 'do_peer.message.id == 6', '-T', 'json', '-x']));
    // tshark nests a subtree's fields under it; collect every "<field>_raw": [hex, offset, length, ...]
    const raw: Record<string, [string, number, number]> = {};
    const walk = (o: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(o)) {
        if (k.endsWith('_raw') && Array.isArray(v)) raw[k.slice(0, -4)] = v as [string, number, number];
        else if (v && typeof v === 'object') walk(v as Record<string, unknown>);
      }
    };
    walk(out[0]._source.layers.do_peer);
    // the request's begin is 9 bytes in: after the 4-byte len, 1-byte id and 4-byte index
    const len = raw['do_peer.message.len'];
    const begin = raw['do_peer.block_ref.begin'];
    assert.equal(begin[1] - len[1], 9);
    assert.equal(begin[2], 4);
  });
});

describe('UDP (rich.ksy: bits, xor, imports, switch, instances)', { skip }, () => {
  const rich = `${fixtures}rich.ksy`;
  const good = Buffer.from([
    ...Buffer.from('RI'),
    2, // ver
    0x81, // flag=1 nib=1
    ...Buffer.from('hi\0'),
    2,
    0, // blen
    0x54,
    0x55, // body.x = 1, xor 0x55
    1, // kind a => sub
    0,
    42, // sub.v
    ...Buffer.from('tail'),
  ]);

  test('values', async () => {
    const [row] = await fields(rich, pcap([udp(good, 9999)]), [
      'rich.ver',
      'rich.flag',
      'rich.nib',
      'rich.name',
      'rich.body.x',
      'rich.kind',
      'rich.sub.v',
      'rich.rest',
      'rich.dbl',
      'rich.first',
    ]);
    assert.deepEqual(row, ['2', 'True', '1', 'hi', '1', '1', '42', '7461696c', '4', '82']);
  });

  test('a failed valid marks the field', async () => {
    const bad = Buffer.from(good);
    bad[2] = 9;
    const out = await tshark(rich, pcap([udp(bad, 9999)]), ['-V', '-O', 'rich']);
    assert.match(out, /ValidationGreaterThanError: ver = 9/);
  });

  test('a truncated packet says where', async () => {
    const out = await tshark(rich, pcap([udp(good.subarray(0, 10), 9999)]), ['-V', '-O', 'rich']);
    assert.match(out, /truncated.*\(after blen\)/);
  });

  test('xor output is its own data source', async () => {
    const out = await tshark(rich, pcap([udp(good, 9999)]), ['-x']);
    assert.match(out, /^body \(2 bytes\):\n0000 {2}01 00/m);
  });
});

describe('process: zlib', { skip }, () => {
  test('decompresses with Wireshark and dissects the result', async () => {
    const inner = Buffer.concat([Buffer.from('hello\0'), Buffer.from([0, 0, 1, 0])]);
    const z = deflateSync(inner);
    const payload = Buffer.concat([Buffer.from([0, z.length]), z]);
    const capture = pcap([udp(payload, 9100)]);
    const [row] = await fields(`${fixtures}zpkt.ksy`, capture, ['zpkt.inner.greeting', 'zpkt.inner.n', '_ws.col.info']);
    assert.deepEqual(row, ['hello', '256', 'hello n=256']);
  });
});
