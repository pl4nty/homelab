import assert from 'node:assert/strict';
import { test } from 'node:test';
import { insertSeqItems, typeChoices } from '../src/util/insertField.ts';

const SPEC = `meta:
  id: my_fmt
  endian: le
seq:
  - id: magic
    contents: [1, 2]
  - id: body
    type: body_t
# trailing comment
types:
  body_t:
    seq:
      - id: a
        type: u1
`;

const apply = (src: string, e: ReturnType<typeof insertSeqItems>) => {
  assert.notEqual(typeof e, 'string', String(e));
  const { offset, text } = e as { offset: number; text: string };
  return src.slice(0, offset) + text + src.slice(offset);
};

test('inserts between root seq items', () => {
  const out = apply(SPEC, insertSeqItems(SPEC, 'MyFmt', 1, [{ id: 'len', attrs: { type: 'u2' } }]));
  assert.match(out, /contents: \[1, 2\]\n {2}- id: len\n {4}type: u2\n {2}- id: body/);
});

test('appends to a nested type seq with its indentation', () => {
  const out = apply(
    SPEC,
    insertSeqItems(SPEC, 'BodyT', 5, [
      { id: 'gap', attrs: { size: 3 } },
      { id: 'b', attrs: { type: 'u4' } },
    ]),
  );
  assert.ok(out.endsWith('        type: u1\n      - id: gap\n        size: 3\n      - id: b\n        type: u4\n'), out);
});

test('errors', () => {
  assert.equal(typeof insertSeqItems(SPEC, 'Nope', 0, []), 'string');
  assert.equal(typeof insertSeqItems('meta: {id: x}\nseq: [{id: a, type: u1}]\n', 'X', 0, []), 'string');
});

test('typeChoices', () => {
  assert.deepEqual(
    typeChoices(2, 'le').map((c) => c.label),
    ['u2le', 'u2be', 's2le', 's2be', 'bytes (size: 2)', 'str UTF-8 (size: 2)', 'strz UTF-8'],
  );
  assert.deepEqual(typeChoices(2, 'le')[0].attrs, { type: 'u2' });
  assert.deepEqual(typeChoices(2, 'le')[1].attrs, { type: 'u2be' });
});
