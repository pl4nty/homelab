import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completionContext, computeCompletions } from '../src/ksy/completion.ts';
import { definitionTarget, diagnosticTargetPath, hoverInfo } from '../src/ksy/language.ts';
import {
  buildTypeTree,
  closeMatches,
  describeBuiltin,
  resolveEnum,
  resolveType,
  typeAt,
  visibleTypes,
} from '../src/ksy/model.ts';
import { classifyPath, keysFor } from '../src/ksy/schema.ts';
import {
  documentSymbols,
  fieldRange,
  nodeAt,
  parseKsyDocument,
  rangeForPath,
  typeKeyRange,
} from '../src/ksy/yamlAst.ts';

const SPEC = `meta:
  id: demo
  endian: le
  imports:
    - common/vlq
seq:
  - id: magic
    contents: [0x44]
  - id: hdr
    type: header
  - id: body
    type:
      switch-on: hdr.kind
      cases:
        kinds::a: chunk
        _: header::inner
instances:
  tail:
    pos: hdr.ofs
    type: u4
types:
  header:
    seq:
      - id: kind
        type: u1
        enum: kinds
      - id: ofs
        type: u4
    types:
      inner:
        seq:
          - { id: x, type: u1 }
  chunk:
    seq:
      - id: data
        size: _parent.hdr.ofs
enums:
  kinds:
    1: a
    2:
      id: b
      doc: the b kind
`;

const at = (text: string, marker = '|') => {
  const offset = text.indexOf(marker);
  return { text: text.slice(0, offset) + text.slice(offset + marker.length), offset };
};

test('classifies paths', () => {
  assert.equal(classifyPath([]).ctx, 'root');
  assert.equal(classifyPath(['meta']).ctx, 'meta');
  assert.deepEqual(classifyPath(['types', 'a', 'types', 'b', 'seq', '*']), {
    ctx: 'attribute',
    typePath: ['a', 'b'],
    enumName: undefined,
    key: '*',
    parentCtx: 'seq',
  });
  assert.equal(classifyPath(['seq', '0', 'type']).ctx, 'switch');
  assert.equal(classifyPath(['seq', '0', 'type', 'cases', 'x']).parentCtx, 'cases');
  assert.equal(classifyPath(['instances', 'foo']).ctx, 'instance');
  assert.equal(classifyPath(['enums', 'e', '1']).ctx, 'enumValue');
  assert.ok(keysFor('attribute').some((k) => k.key === 'repeat-expr' && k.doc));
  assert.ok(!keysFor('attribute').some((k) => k.key === 'pos'));
  assert.ok(keysFor('instance').some((k) => k.key === 'pos'));
  assert.ok(keysFor('meta').some((k) => k.key === 'bit-endian'));
});

test('maps error paths to ranges', () => {
  const p = parseKsyDocument(SPEC);
  const slice = (r: { start: number; end: number }) => SPEC.slice(r.start, r.end);
  assert.equal(slice(rangeForPath(p, SPEC, ['seq', '1', 'type'])), 'header');
  assert.equal(rangeForPath(p, SPEC, ['seq', '1', 'type']).match, 'value');
  // A block value falls back to its key.
  const r = rangeForPath(p, SPEC, ['seq', '2', 'type']);
  assert.equal(slice(r), 'type');
  assert.equal(r.match, 'key');
  // Missing leaf -> deepest existing ancestor key.
  const anc = rangeForPath(p, SPEC, ['types', 'header', 'seq', '0', 'nope']);
  assert.equal(anc.match, 'ancestor');
  assert.equal(slice(anc), 'kind');
  assert.equal(slice(rangeForPath(p, SPEC, ['seq', '0'])), 'magic');
  assert.equal(slice(rangeForPath(p, SPEC, ['types', 'header', 'types', 'inner', 'seq', '0', 'type'])), 'u1');
  assert.equal(slice(rangeForPath(p, SPEC, ['meta', 'imports', '0'])), 'common/vlq');
});

test('diagnostic path for errors inside imports', () => {
  const p = parseKsyDocument(SPEC);
  assert.deepEqual(diagnosticTargetPath(p, { message: 'x', path: ['seq', '0'], file: 'common/vlq' }, 'demo'), [
    'meta',
    'imports',
    '0',
  ]);
  assert.deepEqual(diagnosticTargetPath(p, { message: 'x', path: ['seq', '0'], file: 'vlq' }, 'demo'), [
    'meta',
    'imports',
    '0',
  ]);
  assert.deepEqual(diagnosticTargetPath(p, { message: 'x', path: ['seq', '0'], file: 'demo' }, 'demo'), ['seq', '0']);
  assert.deepEqual(diagnosticTargetPath(p, { message: 'x', path: ['seq', '0'], file: 'other' }, 'demo'), [
    'meta',
    'imports',
  ]);
});

test('resolves types and enums by scope', () => {
  const p = parseKsyDocument(SPEC);
  const root = buildTypeTree(p.js);
  const header = typeAt(root, ['header']);
  const inner = typeAt(root, ['header', 'inner']);
  assert.equal(resolveType(root, 'header'), header);
  assert.equal(resolveType(root, 'header::inner'), inner);
  assert.equal(resolveType(root, 'inner'), undefined);
  assert.equal(resolveType(inner, 'chunk')?.name, 'chunk');
  assert.equal(resolveType(inner, 'inner'), inner);
  assert.equal(resolveType(inner, 'demo'), root);
  assert.equal(resolveType(root, 'header(1, 2)'), header);
  const imp = buildTypeTree({ meta: { id: 'vlq' }, types: { group: {} } });
  assert.equal(resolveType(root, 'vlq::group', [imp])?.name, 'group');
  assert.deepEqual(
    visibleTypes(inner).map((t) => t.name),
    ['inner', 'header', 'chunk'],
  );
  assert.equal(resolveEnum(header, 'kinds')?.owner, root);
  assert.equal(describeBuiltin('u4be'), 'unsigned 32-bit big-endian integer');
  assert.equal(describeBuiltin('b3le'), '3-bit unsigned little-endian bit-sized integer');
  assert.deepEqual(closeMatches('heaedr', ['header', 'chunk', 'u4']), ['header']);
});

test('detects completion context', () => {
  let { text, offset } = at(SPEC.replace('    contents: [0x44]', '    contents: [0x44]\n    re|'));
  let cc = completionContext(text, offset);
  assert.equal(cc.mode, 'key');
  assert.deepEqual(cc.path, ['seq', '*']);
  assert.equal(cc.classified.ctx, 'attribute');
  assert.deepEqual(cc.existing.sort(), ['contents', 'id']);
  assert.equal(cc.prefix, 're');

  ({ text, offset } = at(
    SPEC.replace('        type: u1\n        enum: kinds', '        type: u|\n        enum: kinds'),
  ));
  cc = completionContext(text, offset);
  assert.equal(cc.mode, 'value');
  assert.deepEqual(cc.path, ['types', 'header', 'seq', '*', 'type']);
  assert.deepEqual(cc.classified.typePath, ['header']);

  ({ text, offset } = at(SPEC.replace('{ id: x, type: u1 }', '{ id: x, ty| }')));
  cc = completionContext(text, offset);
  assert.equal(cc.mode, 'key');
  assert.equal(cc.flow, true);
  assert.deepEqual(cc.existing, ['id']);
  assert.deepEqual(cc.path, ['types', 'header', 'types', 'inner', 'seq', '*']);

  ({ text, offset } = at(SPEC.replace('        _: header::inner', '        _: |')));
  cc = completionContext(text, offset);
  assert.equal(cc.classified.parentCtx, 'cases');

  ({ text, offset } = at('meta:\n  id: x\n|'));
  cc = completionContext(text, offset);
  assert.deepEqual(cc.path, []);
  assert.deepEqual(cc.existing, ['meta']);

  ({ text, offset } = at('seq:\n- id: a\n  |'));
  cc = completionContext(text, offset);
  assert.deepEqual(cc.path, ['seq', '*']);
  assert.deepEqual(cc.existing, ['id']);

  ({ text, offset } = at('meta:\n  imports:\n    - |'));
  cc = completionContext(text, offset);
  assert.equal(cc.mode, 'value');
  assert.equal(cc.classified.key, 'imports');
});

test('computes completions', () => {
  const labels = (marker: string, replace: [string, string]) => {
    const { text, offset } = at(SPEC.replace(replace[0], replace[1].replace('|', marker)));
    return computeCompletions(text, offset).items.map((c) => c.label);
  };
  const types = labels('|', ['          - { id: x, type: u1 }', '          - { id: x, type: | }']);
  assert.ok(types.includes('u4be') && types.includes('chunk') && types.includes('header') && types.includes('strz'));
  const enums = labels('|', ['        enum: kinds', '        enum: |']);
  assert.deepEqual(enums, ['kinds']);
  const expr = labels('|', ['    pos: hdr.ofs', '    pos: hdr.|']);
  assert.ok(expr.includes('kind') && expr.includes('ofs'), expr.join());
  const root = labels('|', ['        size: _parent.hdr.ofs', '        size: _root.|']);
  assert.ok(root.includes('magic') && root.includes('tail'));
  const members = labels('|', ['    pos: hdr.ofs', '    pos: kinds::|']);
  assert.deepEqual(members, ['a', 'b']);
  const repeat = labels('|', ['    type: u4\n', '    type: u4\n    repeat: |\n']);
  assert.deepEqual(repeat.sort(), ['eos', 'expr', 'until']);
  const keys = labels('|', ['    type: u4\n', '    type: u4\n    |\n']);
  assert.ok(keys.includes('repeat') && !keys.includes('type') && !keys.includes('pos'));
});

test('extracts outline symbols', () => {
  const p = parseKsyDocument(SPEC);
  const syms = documentSymbols(p, SPEC);
  assert.deepEqual(
    syms.map((s) => s.name),
    ['meta', 'seq', 'instances', 'types', 'enums'],
  );
  assert.equal(syms[0].detail, 'demo');
  assert.deepEqual(
    syms[1].children.map((c) => `${c.name}:${c.detail}`),
    ['magic:contents', 'hdr:header', 'body:switch'],
  );
  const types = syms[3].children;
  assert.deepEqual(
    types.map((t) => t.name),
    ['header', 'chunk'],
  );
  const headerTypes = types[0].children.find((c) => c.name === 'types');
  assert.equal(headerTypes?.children[0].name, 'inner');
  assert.deepEqual(
    syms[4].children[0].children.map((m) => `${m.detail}=${m.name}`),
    ['1=a', '2=b'],
  );
  assert.equal(SPEC.slice(typeKeyRange(p, ['header'])!.start, typeKeyRange(p, ['header'])!.end), 'header');
  const f = fieldRange(p, ['header'], 'ofs')!;
  assert.equal(SPEC.slice(f.start, f.end), 'ofs');
  const t = fieldRange(p, [], 'tail')!;
  assert.equal(SPEC.slice(t.start, t.end), 'tail');
});

test('finds definitions and hovers', () => {
  const p = parseKsyDocument(SPEC);
  const off = (s: string, delta = 0) => SPEC.indexOf(s) + delta;
  const n = nodeAt(p, off('type: header', 7));
  assert.deepEqual(n?.path, ['seq', '1', 'type']);
  let d = definitionTarget(p, SPEC, off('type: header', 8));
  assert.equal(d?.kind, 'local');
  assert.equal(d?.kind === 'local' && SPEC.slice(d.range.start, d.range.end), 'header');
  d = definitionTarget(p, SPEC, off('_: header::inner', 13));
  assert.equal(d?.kind === 'local' && SPEC.slice(d.range.start, d.range.end), 'inner');
  d = definitionTarget(p, SPEC, off('kinds::a', 2));
  assert.equal(d?.kind === 'local' && SPEC.slice(d.range.start, d.range.end), 'kinds');
  d = definitionTarget(p, SPEC, off('kinds::a', 7));
  assert.equal(d?.kind === 'local' && SPEC.slice(d.range.start, d.range.end), '1');
  d = definitionTarget(p, SPEC, off('hdr.ofs', 5));
  assert.equal(d?.kind === 'local' && SPEC.slice(d.range.start, d.range.end), 'ofs');
  d = definitionTarget(p, SPEC, off('switch-on: hdr.kind', 12));
  assert.equal(d?.kind === 'local' && d.range.start, off('id: hdr', 4));
  d = definitionTarget(p, SPEC, off('_parent.hdr.ofs', 9));
  assert.equal(d?.kind === 'local' && d.range.start, off('id: hdr', 4));
  d = definitionTarget(p, SPEC, off('common/vlq', 2));
  assert.deepEqual(d, { kind: 'import', name: 'common/vlq', mode: 'rel' });
  d = definitionTarget(p, SPEC, off('enum: kinds', 7));
  assert.equal(d?.kind === 'local' && SPEC.slice(d.range.start, d.range.end), 'kinds');

  assert.match(hoverInfo(p, SPEC, off('type: u4', 7))?.markdown ?? '', /unsigned 32-bit integer/);
  assert.match(hoverInfo(p, SPEC, off('contents', 1))?.markdown ?? '', /fixed contents/);
  assert.match(hoverInfo(p, SPEC, off('type: header', 8))?.markdown ?? '', /types\/header/);
  assert.match(hoverInfo(p, SPEC, off('enum: kinds', 7))?.markdown ?? '', /1: `a`/);
});
