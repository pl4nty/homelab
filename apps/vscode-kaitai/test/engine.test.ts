import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { compileTemplate, generateCode, KsyError, LANGUAGES } from '../src/engine/kaitai.ts';
import { findById, findDeepestNode, regionsInRange, toJson } from '../src/engine/structure.ts';

const noImports = async () => {
  throw new Error('no imports');
};

const SPEC = `
meta: { id: t_x, endian: le, file-extension: [tx, txx] }
seq:
  - { id: magic, contents: [0x54, 0x58] }
  - { id: icc_4, type: u1 }
  - { id: kind, type: u2, enum: kinds }
  - { id: sub_block, size: 3, type: sub }
  - { id: packed, size: 9, process: zlib, type: sub }
  - { id: items, type: u1, repeat: expr, repeat-expr: 3 }
instances:
  at_zero: { pos: 0, type: u1 }
  boom: { pos: 1000, type: u4 }
enums:
  kinds: { 1: first_kind, 2: second }
types:
  sub:
    seq:
      - { id: a, type: u1 }
      - { id: b, type: u2 }
`;

test('compiles and builds a tree with ksy names, ranges and enums', async () => {
  const t = await compileTemplate(SPEC.replace('size: 9', 'size: 11'), noImports);
  assert.deepEqual(t.fileExtensions, ['tx', 'txx']);
  const packed = deflateSync(Buffer.from([7, 8, 0]));
  const data = new Uint8Array([0x54, 0x58, 9, 1, 0, 1, 2, 0, ...packed, 4, 5, 6]);
  const { roots, error } = t.parse(data);
  assert.equal(error, undefined);
  const root = roots[0];
  const names = root.children().map((c) => c.name);
  assert.deepEqual(names, ['magic', 'icc_4', 'kind', 'sub_block', 'packed', 'items', 'at_zero', 'boom']);
  const kind = findById(roots, 't_x/kind')!;
  assert.equal(kind.value, 'first_kind = 1 (0x1)');
  assert.deepEqual(kind.range, { start: 3, end: 5 });
  // Substream ranges are absolute.
  const b = findById(roots, 't_x/sub_block/b')!;
  assert.deepEqual(b.range, { start: 6, end: 8 });
  // Processed streams: decoded value, no range inside, raw range on the field.
  const pb = findById(roots, 't_x/packed/a')!;
  assert.equal(pb.raw, 7);
  assert.equal(pb.range, undefined);
  assert.deepEqual(findById(roots, 't_x/packed')!.range, { start: 8, end: 19 });
  // Instances parse lazily; a failing instance gets an error node.
  const boom = root.children().find((c) => c.name === 'boom')!;
  assert.ok(boom.error);
  assert.equal(boom.instance, true);
  assert.equal(findDeepestNode(roots, 7)!.id, 't_x/sub_block/b');
  assert.equal(findDeepestNode(roots, 20)!.id, 't_x/items/[1]');
  const regs = regionsInRange(roots, 0, data.length);
  assert.equal(regs[0].id, 't_x/magic');
  assert.ok(regs.some((r) => r.id === 't_x/packed'));
  const json = toJson(root) as Record<string, unknown>;
  assert.deepEqual(json.items, [4, 5, 6]);
  assert.equal(json.icc_4, 9);
});

test('partial parse marks where it stopped', async () => {
  const t = await compileTemplate(SPEC.replace('size: 9', 'size: 11'), noImports);
  const { roots, error } = t.parse(new Uint8Array([0x54, 0x58, 9, 1, 0, 1]));
  assert.ok(error);
  const sub = findById(roots, 't_x/sub_block')!;
  assert.equal(sub.error, 'Parsing stopped here');
});

test('compile errors carry a YAML path', async () => {
  await assert.rejects(
    compileTemplate('meta: {id: x}\nseq:\n  - id: a\n    type: nope\n', noImports),
    (e: KsyError) =>
      e instanceof KsyError && e.path?.join('/') === 'seq/0/type' && e.message.startsWith('unable to find type'),
  );
  await assert.rejects(
    compileTemplate('meta: {id: x}\nseq:\n  - {id: a, type: u1, if: "foo +"}\n', noImports),
    (e: KsyError) => e.path?.join('/') === 'seq/0/if' && e.file === undefined,
  );
});

test('imports and code generation', async () => {
  const lib = 'meta: {id: lib}\nseq:\n  - {id: v, type: u1}\n';
  const seen: string[] = [];
  const t = await compileTemplate('meta: {id: main, imports: [lib]}\nseq:\n  - {id: x, type: lib}\n', async (n, m) => {
    seen.push(`${m}:${n}`);
    return lib;
  });
  assert.deepEqual(seen, ['rel:lib']);
  assert.equal(findById(t.parse(new Uint8Array([5])).roots, 'main/x/v')!.raw, 5);
  assert.ok(LANGUAGES.includes('python'));
  const py = await generateCode(lib, 'python', noImports);
  assert.ok(Object.values(py)[0].includes('class Lib'));
});

test('large arrays are bucketed', async () => {
  const t = await compileTemplate('meta: {id: arr}\nseq:\n  - {id: a, type: u1, repeat: eos}\n', noImports);
  const { roots } = t.parse(new Uint8Array(250));
  const a = findById(roots, 'arr/a')!;
  assert.deepEqual(
    a.children().map((c) => c.name),
    ['[0..99]', '[100..199]', '[200..249]'],
  );
  assert.equal(findDeepestNode(roots, 150)!.name, '[150]');
  assert.equal((toJson(a) as unknown[]).length, 250);
});

test('params, parse-as-type with base offset, representation, stream bytes', async () => {
  const spec = `
meta: { id: p, endian: le }
params:
  - { id: n, type: u1 }
seq:
  - { id: head, size: n }
  - { id: rec, type: rec }
  - { id: z, size: 11, process: zlib, type: rec }
types:
  rec:
    -webide-representation: '{tag:hex} len={len:dec}'
    seq:
      - { id: tag, type: u1 }
      - { id: len, type: u2 }
`;
  const t = await compileTemplate(spec, noImports);
  assert.deepEqual(t.params, [{ id: 'n', type: 'u1', doc: undefined }]);
  assert.deepEqual(t.typeNames, ['rec']);
  const packed = deflateSync(Buffer.from([0xab, 2, 0]));
  const data = new Uint8Array([1, 2, 0xff, 3, 0, ...packed]);
  const { roots, error } = t.parse(data, { params: [2] });
  assert.equal(error, undefined);
  assert.deepEqual(findById(roots, 'p/head')!.raw, new Uint8Array([1, 2]));
  assert.equal(findById(roots, 'p/rec')!.value, '0xFF len=3');
  const z = findById(roots, 'p/z')!;
  assert.deepEqual(Array.from(z.streamBytes!()), [0xab, 2, 0]);
  assert.equal(findById(roots, 'p/rec')!.streamBytes, undefined);
  const sel = t.parse(data.subarray(2, 5), { typeName: 'rec', baseOffset: 2, rootName: 'rec@0x2' });
  assert.deepEqual(findById(sel.roots, 'rec@0x2/len')!.range, { start: 3, end: 5 });
});

test('real gallery spec: png.ksy with relative imports', async () => {
  const { readFile } = await import('node:fs/promises');
  const dir = new URL('./fixtures/image/', import.meta.url);
  const read = async (name: string) => readFile(new URL(`${name}.ksy`, dir), 'utf8');
  const t = await compileTemplate(await read('png'), (n) => read(n));
  assert.deepEqual([...t.specs.keys()].sort(), ['exif', 'icc_4', 'png']);
  const data = new Uint8Array(await readFile(new URL('./fixtures/sample.png', import.meta.url)));
  const { roots, error } = t.parse(data);
  assert.equal(error, undefined);
  assert.equal(findById(roots, 'png/ihdr/width')!.raw, 16);
  assert.deepEqual(findById(roots, 'png/ihdr/color_type')!.value, 'truecolor = 2 (0x2)');
  const chunks = findById(roots, 'png/chunks')!.children();
  assert.equal(chunks.length, 3);
  assert.equal(findById(roots, 'png/chunks/[0]/body/keyword')?.raw, 'Comment');
  assert.equal(findDeepestNode(roots, 0x10)!.id, 'png/ihdr/width');
});

test('validation failures mark the field', async () => {
  const t = await compileTemplate('meta: {id: v}\nseq:\n  - {id: a, type: u1, valid: 5}\n', noImports);
  const { roots, error } = t.parse(new Uint8Array([4]));
  assert.ok(error);
  assert.match(findById(roots, 'v/a')!.error!, /^Validation failed/);
});
