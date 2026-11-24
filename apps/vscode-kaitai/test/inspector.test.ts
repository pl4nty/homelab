import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  asciiPreview,
  binary,
  decode,
  escapeControls,
  formatFloat,
  formatUnixTime,
  lengthText,
  MISSING,
  type Row,
  textPreview,
} from '../src/webview/inspector/decode.ts';

const row = (rows: Row[], label: string) => {
  const r = rows.find((x) => x.label === label);
  assert.ok(r, label);
  return r;
};

test('integers in both byte orders, signed and unsigned, including 64-bit', () => {
  const rows = decode(new Uint8Array([0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x80]), 0);
  assert.equal(row(rows, 'u8').value, '254');
  assert.equal(row(rows, 'i8').value, '-2');
  assert.deepEqual([row(rows, 'u16').le, row(rows, 'u16').be], ['65534', '65279']);
  assert.deepEqual([row(rows, 'i16').le, row(rows, 'i16').be], ['-2', '-257']);
  assert.deepEqual([row(rows, 'u32').le, row(rows, 'i32').le], ['4294967294', '-2']);
  assert.equal(row(rows, 'u64').le, '9295429630892703742');
  assert.equal(row(rows, 'i64').le, '-9151314442816847874');
  assert.equal(row(rows, 'u64').be, '18374686479671623552');
  assert.equal(row(rows, 'i64').be, '-72057594037928064');
});

test('floats: NaN, infinities, negative zero and ordinary values', () => {
  assert.equal(formatFloat(Number.NaN), 'NaN');
  assert.equal(formatFloat(Number.POSITIVE_INFINITY), 'Infinity');
  assert.equal(formatFloat(Number.NEGATIVE_INFINITY), '-Infinity');
  assert.equal(formatFloat(-0), '-0');
  let rows = decode(new Uint8Array([0x00, 0x00, 0x80, 0x7f, 0, 0, 0xf0, 0xff]), 0);
  assert.equal(row(rows, 'f32').le, 'Infinity');
  assert.equal(row(rows, 'f64').le, 'NaN');
  rows = decode(new Uint8Array([0xbf, 0xc0, 0x00, 0x00]), 0);
  assert.equal(row(rows, 'f32').be, '-1.5');
  assert.equal(row(rows, 'f64').be, MISSING);
});

test('unix times are ISO UTC, with invalid for out-of-range i64', () => {
  assert.equal(formatUnixTime(0), '1970-01-01T00:00:00Z');
  assert.equal(formatUnixTime(-1n), '1969-12-31T23:59:59Z');
  assert.equal(formatUnixTime(2n ** 62n), 'invalid');
  assert.equal(formatUnixTime(8.64e12), '+275760-09-13T00:00:00Z');
  assert.equal(formatUnixTime(8.64e12 + 1), 'invalid');
  const rows = decode(new Uint8Array([0x00, 0x5e, 0xd0, 0xb2]), 0);
  assert.equal(row(rows, 'unix u32').le, '2065-01-24T05:20:00Z');
  assert.equal(row(rows, 'unix u32').be, '1970-03-13T22:03:30Z');
  assert.equal(row(rows, 'unix i64').le, MISSING);
});

test('short buffers give dashes for rows that need more bytes', () => {
  const rows = decode(new Uint8Array([0x41, 0x42, 0x43]), 3);
  assert.equal(row(rows, 'u16').le, '16961');
  assert.equal(row(rows, 'u32').le, MISSING);
  assert.equal(row(rows, 'u32').be, MISSING);
  assert.equal(row(rows, 'f64').le, MISSING);
  assert.equal(row(rows, 'ASCII').value, 'ABC');
  assert.equal(row(rows, 'UTF-16').le, '䉁');
  assert.equal(row(rows, 'selection').value, '0x3 (3)');
  const empty = decode(new Uint8Array(), 0);
  for (const r of empty) {
    if (r.label === 'selection') continue;
    for (const v of [r.value, r.le, r.be].filter((x) => x !== undefined)) assert.equal(v, MISSING, r.label);
  }
});

test('string previews escape control characters', () => {
  assert.equal(asciiPreview(new Uint8Array([0x48, 0x00, 0x0a, 0x1f, 0x7f, 0xc3, 0x5c])), 'H\\0\\n\\x1f\\x7f\\xc3\\\\');
  assert.equal(escapeControls('a\tb\u0085c '), 'a\\tb\\x85c\\u2028');
  assert.equal(textPreview(new TextEncoder().encode('é\r'), 'utf-8'), 'é\\r');
  assert.equal(textPreview(new Uint8Array([0x00, 0x41, 0x00, 0x0a]), 'utf-16be'), 'A\\n');
  assert.equal(textPreview(new Uint8Array([0x41]), 'utf-16le'), MISSING);
});

test('binary and length formatting', () => {
  assert.equal(binary(0xa5), '1010 0101');
  assert.equal(binary(undefined), MISSING);
  assert.equal(lengthText(255), '0xFF (255)');
});
