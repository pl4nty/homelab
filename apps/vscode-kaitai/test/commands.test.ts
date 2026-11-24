import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INVALID, parseParamValue, parseRange } from '../src/util/parse.ts';

test('parseRange', () => {
  assert.deepEqual(parseRange('0x10', 100), { start: 16, end: 16 });
  assert.deepEqual(parseRange('0x10-0x1f', 100), { start: 16, end: 32 });
  assert.deepEqual(parseRange('16+4', 100), { start: 16, end: 20 });
  assert.equal(parseRange('200', 100), undefined);
  assert.equal(parseRange('zz', 100), undefined);
});

test('parseParamValue', () => {
  assert.equal(parseParamValue('0x10', 'u1'), 16);
  assert.equal(parseParamValue('-5'), -5);
  assert.equal(parseParamValue('18446744073709551615', 'u8'), 18446744073709551615n);
  assert.equal(parseParamValue('true', 'bool'), true);
  assert.equal(parseParamValue('maybe', 'bool'), INVALID);
  assert.deepEqual(parseParamValue('[1, 0xff]'), new Uint8Array([1, 255]));
  assert.equal(parseParamValue('"hi"'), 'hi');
  assert.equal(parseParamValue('hi', 'str'), 'hi');
  assert.equal(parseParamValue('1.5'), 1.5);
});

test('parseOpenQuery', async () => {
  const { parseOpenQuery } = await import('../src/util/openQuery.ts');
  assert.deepEqual(parseOpenQuery('data=%2Ftmp%2Fa.bin&ksy=%2Fx.ksy&offset=0x10&length=4'), {
    data: '/tmp/a.bin',
    ksy: '/x.ksy',
    offset: 16,
    length: 4,
  });
  assert.equal(typeof parseOpenQuery('ksy=a'), 'string');
  assert.equal(typeof parseOpenQuery('data=a&offset=zz'), 'string');
});
