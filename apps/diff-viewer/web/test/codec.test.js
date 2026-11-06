import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFragment, encodeFragment, fromBase64Url, seal, toBase64Url, unseal } from '../src/codec.js';

const doc = { a: 'hello world\n', b: 'hello there world\n🎉\n', name: 'greeting.txt' };

test('base64url round-trips every byte value', () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
  const text = toBase64Url(bytes);
  assert.match(text, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(fromBase64Url(text), bytes);
});

test('fragment round-trips a document', async () => {
  assert.deepEqual(await decodeFragment(await encodeFragment(doc)), doc);
});

test('sealed blob opens with its key and not another', async () => {
  const { blob, key } = await seal(doc);
  assert.deepEqual(await unseal(blob, key), doc);
  const other = await seal(doc);
  await assert.rejects(unseal(blob, other.key));
});

test('large documents compress', async () => {
  const big = { patch: 'diff --git a/x b/x\n'.repeat(20_000) };
  const fragment = await encodeFragment(big);
  assert.ok(fragment.length < 5_000);
  assert.deepEqual(await decodeFragment(fragment), big);
});
