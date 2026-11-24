import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findAll, type Needle, parseNeedle } from '../src/util/search.ts';

const n = (q: string, e?: 'le' | 'be') => parseNeedle(q, e) as Needle;

test('parseNeedle', () => {
  assert.deepEqual(Array.from(n('u4le 0x01020304').bytes), [4, 3, 2, 1]);
  assert.deepEqual(Array.from(n('u2 1', 'be').bytes), [0, 1]);
  assert.deepEqual(Array.from(n('s2le -2').bytes), [0xfe, 0xff]);
  assert.equal(typeof parseNeedle('u1 256'), 'string');
  assert.deepEqual(Array.from(n('f4be 1').bytes), [0x3f, 0x80, 0, 0]);
  assert.deepEqual(Array.from(n('"PNG"').bytes), [0x50, 0x4e, 0x47]);
  assert.deepEqual(Array.from(n('utf-16le "A"').bytes), [0x41, 0]);
  const w = n('89 ?? 4e');
  assert.deepEqual(Array.from(w.mask!), [0xff, 0, 0xff]);
  assert.deepEqual(Array.from(n('0xFFD8').bytes), [0xff, 0xd8]);
  assert.equal(typeof parseNeedle('nonsense query'), 'string');
});

test('findAll', () => {
  const data = new Uint8Array([1, 2, 1, 2, 1, 3]);
  assert.deepEqual(findAll(data, n('01 02')), [0, 2]);
  assert.deepEqual(findAll(data, n('01 ??')), [0, 2, 4]);
  assert.deepEqual(findAll(data, n('02 01'), 1), [1]);
  assert.deepEqual(findAll(data, n('03 04')), []);
});
