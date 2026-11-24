import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSchema, resolveType, upperCamel } from '../src/schema.ts';

test('class names follow the compiler', () => {
  assert.equal(upperCamel('do_peer'), 'DoPeer');
  assert.equal(upperCamel('ipv4_header'), 'Ipv4Header');
  assert.equal(upperCamel('_private'), '_Private');
});

test('field kinds, enums and nested types', () => {
  const schema = buildSchema([
    {
      meta: { id: 'top' },
      seq: [
        { id: 'a', type: 'u2le', enum: 'kind' },
        { id: 'b', type: 'b1' },
        { id: 'c', type: 'b12' },
        { id: 'd', type: 'strz', encoding: 'ASCII' },
        { id: 'e', size: 4 },
        { id: 'f', type: 'inner' },
        { id: 'g', type: { 'switch-on': 'a', cases: { 1: 'inner', 2: 'u4' } } },
        { id: 'h', type: 'other::thing', enum: 'other::color' },
        { type: 'f8be' },
      ],
      instances: { v: { value: 'a * 2' } },
      enums: { kind: { 1: 'one', 16: { id: 'sixteen', doc: 'x' } } },
      types: {
        inner: { params: [{ id: 'p', type: 'u1' }], seq: [{ id: 'x', type: 's4', enum: 'kind' }] },
      },
    },
    { meta: { id: 'other' }, enums: { color: { 0: 'red' } }, types: { thing: {} } },
  ]);
  const kinds = Object.fromEntries(schema.types.top.fields.map((f) => [f.id, f.kind]));
  assert.deepEqual(kinds, {
    a: 'u2',
    b: 'bool',
    c: 'u2',
    d: 'string',
    e: 'bytes',
    f: 'struct',
    g: 'switch',
    h: 'struct',
    _unnamed8: 'double',
    v: 'value',
  });
  assert.equal(schema.types['top.inner'].lua, 'Top.Inner');
  assert.deepEqual(schema.types['top.inner'].param_ids, ['p']);
  assert.deepEqual(schema.types.top.instances, ['v']);
  // nested types see the enclosing type's enums; imported enums resolve by spec id
  assert.equal(schema.types['top.inner'].fields[0].enum, 'top.kind');
  assert.equal(schema.types.top.fields[7].enum, 'other.color');
  assert.deepEqual(schema.enums['top.kind'], { 1: 'one', 16: 'sixteen' });
  assert.equal(resolveType(schema, 'top', 'inner'), 'top.inner');
  assert.equal(resolveType(schema, 'top', 'other'), 'other');
  assert.throws(() => resolveType(schema, 'top', 'nope'));
});
