import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COPY_FORMATS } from '../src/util/copyAs.ts';

const b = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const f = (k: keyof typeof COPY_FORMATS, bytes = b) => COPY_FORMATS[k].format(bytes);

test('copy-as formats', () => {
  assert.equal(f('hexOctets'), '89 50 4e 47');
  assert.equal(f('hex'), '89504e47');
  assert.equal(f('literal'), '"\\x89\\x50\\x4e\\x47"');
  assert.equal(f('utf8', new TextEncoder().encode('héllo')), 'héllo');
  assert.equal(f('c'), 'unsigned char data[4] = { 0x89, 0x50, 0x4e, 0x47 };');
  assert.equal(f('go'), 'data := []byte{0x89, 0x50, 0x4e, 0x47}');
  assert.equal(f('java'), 'byte[] data = { (byte) 0x89, 0x50, 0x4e, 0x47 };');
  assert.equal(f('python'), "data = b'\\x89\\x50\\x4e\\x47'");
  assert.equal(f('json'), '[137,80,78,71]');
  assert.equal(f('base64'), 'iVBORw==');
});

test('base64 of a large selection', () => {
  const big = new Uint8Array(100_000).map((_, i) => i);
  assert.equal(f('base64', big), Buffer.from(big).toString('base64'));
});
