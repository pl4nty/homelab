import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { compileTemplate } from '../src/engine/kaitai.ts';
import { type Region, regionsInRange } from '../src/engine/structure.ts';
import {
  asciiCellX,
  assignColours,
  colourKey,
  columns,
  findStep,
  gapsIn,
  hexCellX,
  hitColumn,
  keyedRegionsInRange,
  keyHue,
  keyTone,
  mergeRegions,
  nativeToVirtual,
  nextField,
  offsetDigits,
  prevField,
  regionAt,
  rowContour,
  rowCount,
  scrollModel,
  scrollToRow,
  selectionRange,
  virtualToNative,
  visibleRows,
} from '../src/webview/hex/model.ts';

const noImports = async () => {
  throw new Error('no imports');
};

const GAPPY = `
meta: {id: gappy, endian: le}
seq:
  - {id: magic, contents: "GAP!"}
  - {id: count, type: u2}
  - {id: recs, type: rec, repeat: expr, repeat-expr: count}
  - {id: hdr, size: 12, type: partial}
  - {id: tail, type: u2}
types:
  rec:
    seq:
      - {id: kind, type: u1}
      - {id: len, type: u1}
      - {id: body, size: len}
  partial:
    seq:
      - {id: a, type: u2}
      - {id: b, type: u2}
`;

/** magic(4) count(2) 3 recs of 2+len bytes, hdr(12: 4 parsed + 8 gap), tail(2), 10 trailing bytes. */
function gappyData() {
  const recs = [
    [0, 2, 0xaa, 0xbb],
    [1, 0],
    [2, 1, 0xcc],
  ].flat();
  const hdr = [1, 0, 2, 0, ...new Array(8).fill(0)];
  return new Uint8Array([0x47, 0x41, 0x50, 0x21, 3, 0, ...recs, ...hdr, 9, 9, ...new Array(10).fill(7)]);
}

test('rows and offset width', () => {
  assert.equal(rowCount(0, 16), 1);
  assert.equal(rowCount(16, 16), 1);
  assert.equal(rowCount(17, 16), 2);
  assert.equal(offsetDigits(0), 4);
  assert.equal(offsetDigits(0x10000), 4);
  assert.equal(offsetDigits(0x10001), 6);
  assert.equal(offsetDigits(256 * 1024 * 1024), 8);
  assert.equal(offsetDigits(2 ** 32 + 1), 10);
});

test('column layout and hit testing round-trip', () => {
  for (const bpr of [8, 16, 32]) {
    const c = columns(1000, bpr);
    assert.equal(c.hexStart, c.offsetChars);
    // Gap after every 8 bytes.
    if (bpr > 8) assert.equal(hexCellX(c, 8) - hexCellX(c, 7), 4);
    assert.equal(hexCellX(c, 1) - hexCellX(c, 0), 3);
    assert.ok(asciiCellX(c, 0) > hexCellX(c, bpr - 1) + 2);
    for (let col = 0; col < bpr; col++) {
      for (const dx of [0, 1, 1.9]) assert.deepEqual(hitColumn(c, hexCellX(c, col) + dx), { col, area: 'hex' });
      assert.deepEqual(hitColumn(c, asciiCellX(c, col) + 0.5), { col, area: 'ascii' });
    }
    assert.equal(hitColumn(c, 0).area, 'offset');
    assert.deepEqual(hitColumn(c, c.width + 50), { col: bpr - 1, area: 'ascii' });
  }
});

test('scroll mapping is identity for small files and proportional for huge ones', () => {
  const small = scrollModel(1000, 20, 400);
  assert.equal(small.scaled, false);
  assert.equal(nativeToVirtual(small, 1234), 1234);
  assert.equal(virtualToNative(small, 1234), 1234);
  assert.equal(nativeToVirtual(small, 1e9), small.maxVirtual);

  // 256 MB at 16 bytes per row: 16M rows, far beyond what a DOM element can be tall.
  const rows = (256 * 1024 * 1024) / 16;
  const big = scrollModel(rows, 20, 600);
  assert.equal(big.scaled, true);
  assert.ok(big.spacer <= 8_000_000);
  assert.equal(nativeToVirtual(big, 0), 0);
  assert.equal(nativeToVirtual(big, big.maxNative), big.maxVirtual);
  const mid = nativeToVirtual(big, big.maxNative / 2);
  assert.ok(Math.abs(mid - big.maxVirtual / 2) < 1);
  for (const v of [0, 12345, big.maxVirtual / 3, big.maxVirtual]) {
    assert.ok(Math.abs(nativeToVirtual(big, virtualToNative(big, v)) - v) < 1e-3);
  }
  // The last row is reachable.
  const vis = visibleRows(big.maxVirtual, 20, 600, rows);
  assert.equal(vis.first + vis.count, rows);
});

test('visible rows and scrolling a row into view', () => {
  assert.deepEqual(visibleRows(0, 20, 100, 1000), { first: 0, y0: 0, count: 5 });
  assert.deepEqual(visibleRows(30, 20, 100, 1000), { first: 1, y0: -10, count: 6 });
  assert.equal(visibleRows(0, 20, 100, 3).count, 3);
  assert.equal(scrollToRow(0, 2, 20, 100), 0);
  assert.equal(scrollToRow(0, 10, 20, 100), 120);
  assert.equal(scrollToRow(500, 3, 20, 100), 60);
  assert.equal(scrollToRow(0, 50, 20, 100, true), 960);
});

test('selection range', () => {
  assert.deepEqual(selectionRange({ anchor: 5, caret: 2, active: true }), { start: 2, end: 6 });
  assert.deepEqual(selectionRange({ anchor: 5, caret: 5, active: true }), { start: 5, end: 6 });
  assert.deepEqual(selectionRange({ anchor: 1, caret: 5, active: false }), { start: 5, end: 5 });
});

test('keyed regions match regionsInRange', async () => {
  const t = await compileTemplate(GAPPY, noImports);
  const { roots } = t.parse(gappyData());
  for (const [s, e] of [
    [0, 100],
    [5, 9],
    [14, 22],
  ]) {
    assert.deepEqual(keyedRegionsInRange(roots, s, e).regions, regionsInRange(roots, s, e));
  }
  // Inside the unparsed part of hdr, the struct is not reported as covering the window.
  assert.deepEqual(keyedRegionsInRange(roots, 20, 23).regions, []);
  const read = (name: string) => readFileSync(new URL(`fixtures/image/${name}.ksy`, import.meta.url), 'utf8');
  const png = await compileTemplate(read('png'), async (n) => read(n.split('/').pop()!));
  const img = new Uint8Array(readFileSync(new URL('fixtures/sample.png', import.meta.url)));
  const pr = png.parse(img).roots;
  assert.deepEqual(keyedRegionsInRange(pr, 0, img.length).regions, regionsInRange(pr, 0, img.length));
});

/** Every pair of touching regions gets different colours, and colours do not depend on the window. */
function checkColours(regions: Region[], keys: number[]) {
  const colours = assignColours(regions, keys);
  for (let i = 1; i < regions.length; i++) {
    if (regions[i - 1].end === regions[i].start) {
      assert.notEqual(colours[i], colours[i - 1], `${regions[i - 1].id} vs ${regions[i].id}`);
    }
  }
  return colours;
}

test('adjacent fields always get different colours, stable across windows', async () => {
  const t = await compileTemplate(GAPPY, noImports);
  const { roots } = t.parse(gappyData());
  const all = keyedRegionsInRange(roots, 0, 100);
  const colours = checkColours(all.regions, all.keys);
  // Same colours when only part of the file is requested (as the webview does, block by block).
  const part = keyedRegionsInRange(roots, 8, 14);
  const partColours = assignColours(part.regions, part.keys);
  part.regions.forEach((r, i) => {
    const j = all.regions.findIndex((x) => x.id === r.id);
    if (j > 0 && part.regions[i - 1]?.id === all.regions[j - 1].id) assert.equal(partColours[i], colours[j]);
  });
  // Nesting shows: fields of a record differ in hue from the top-level fields.
  const magic = all.regions.findIndex((r) => r.id === 'gappy/magic');
  const kind = all.regions.findIndex((r) => r.id === 'gappy/recs/[0]/kind');
  assert.notEqual(keyHue(all.keys[magic]), keyHue(all.keys[kind]));

  // A big bucketed array: items alternate by absolute index even across bucket edges.
  const arr = await compileTemplate('meta: {id: arr}\nseq:\n  - {id: a, type: u1, repeat: eos}\n', noImports);
  const ar = arr.parse(new Uint8Array(1000)).roots;
  const k = keyedRegionsInRange(ar, 95, 105);
  checkColours(k.regions, k.keys);
  assert.deepEqual(
    k.keys.map(keyTone),
    k.regions.map((r) => r.start & 1),
  );
});

test('colour keys', () => {
  assert.equal(colourKey([0]), 0);
  assert.notEqual(colourKey([0, 0]), colourKey([0, 1]));
  assert.notEqual(keyHue(colourKey([0, 0, 0])), keyHue(colourKey([0, 1, 0])));
  assert.notEqual(keyHue(colourKey([0, 0])), keyHue(colourKey([0, 0, 0])));
  const r = (start: number, end: number): Region => ({ start, end, id: `${start}`, depth: 1, label: '' });
  // A run of equal keys gets the tie-break tone.
  assert.deepEqual(assignColours([r(0, 1), r(1, 2), r(3, 4)], [3, 3, 3]), [3, 5, 3]);
});

test('region lookup, merge and gaps', () => {
  const r = (start: number, end: number, id = `${start}`): Region => ({ start, end, id, depth: 1, label: id });
  const regions = [r(0, 4), r(4, 6), r(10, 20), r(12, 14, 'inner'), r(30, 31)];
  assert.equal(regionAt(regions, 0), 0);
  assert.equal(regionAt(regions, 5), 1);
  assert.equal(regionAt(regions, 7), -1);
  assert.equal(regions[regionAt(regions, 13)].id, 'inner');
  assert.equal(regionAt(regions, 15), 2);
  assert.deepEqual(gapsIn(regions, 0, 40), [
    { start: 6, end: 10 },
    { start: 20, end: 30 },
    { start: 31, end: 40 },
  ]);
  assert.deepEqual(gapsIn(regions, 2, 25, 22), [
    { start: 6, end: 10 },
    { start: 20, end: 22 },
  ]);
  assert.deepEqual(gapsIn([], 3, 9), [{ start: 3, end: 9 }]);
  assert.equal(nextField(regions, 4)?.start, 10);
  assert.equal(prevField(regions, 10)?.start, 4);
  assert.equal(prevField(regions, 0), undefined);
  const m = mergeRegions([
    { regions: [r(0, 4), r(4, 6)], keys: [1, 2] },
    { regions: [r(4, 6), r(10, 20)], keys: [2, 3] },
  ]);
  assert.deepEqual(
    m.regions.map((x) => x.start),
    [0, 4, 10],
  );
  assert.deepEqual(m.keys, [1, 2, 3]);
});

test('steppers find unparsed gaps and fields in both directions', async () => {
  const t = await compileTemplate(GAPPY, noImports);
  const data = gappyData();
  const { roots } = t.parse(data);
  const size = data.length;
  // Layout: recs end at 6+4+2+3 = 15; hdr 15..27 parses a,b (15..19), gap 19..27; tail 27..29; gap 29..39.
  assert.deepEqual(findStep(roots, size, 'gap', 1, 0), { start: 19, end: 27 });
  assert.deepEqual(findStep(roots, size, 'gap', 1, 19), { start: 29, end: 39 });
  assert.equal(findStep(roots, size, 'gap', 1, 29), undefined);
  assert.deepEqual(findStep(roots, size, 'gap', -1, 29), { start: 19, end: 27 });
  assert.equal(findStep(roots, size, 'gap', -1, 19), undefined);
  // Caret inside a gap: previous goes to the start of that whole gap.
  assert.deepEqual(findStep(roots, size, 'gap', -1, 33), { start: 29, end: 39 });
  const next = findStep(roots, size, 'field', 1, 0) as Region;
  assert.equal(next.id, 'gappy/count');
  assert.equal((findStep(roots, size, 'field', 1, 19) as Region).id, 'gappy/tail');
  assert.equal((findStep(roots, size, 'field', -1, 27) as Region).id, 'gappy/hdr/b');
  assert.equal(findStep(roots, size, 'field', -1, 0), undefined);
  assert.equal(findStep(roots, size, 'field', 1, 27), undefined);
});

test('steppers work across chunk boundaries on large inputs', async () => {
  // A u4 header, then a 200 KB hole, then a trailer: the gap spans several 64 KB chunks.
  const spec = `
meta: {id: big, endian: le}
seq:
  - {id: head, type: u4}
  - {id: body, size: 200000, type: inner}
  - {id: trailer, type: u4}
types:
  inner:
    seq:
      - {id: x, type: u1}
`;
  const t = await compileTemplate(spec, noImports);
  const data = new Uint8Array(200008);
  const { roots } = t.parse(data);
  assert.deepEqual(findStep(roots, data.length, 'gap', 1, 0), { start: 5, end: 200004 });
  assert.deepEqual(findStep(roots, data.length, 'gap', -1, 200004), { start: 5, end: 200004 });
  assert.equal((findStep(roots, data.length, 'field', 1, 4) as Region).id, 'big/trailer');
  assert.equal((findStep(roots, data.length, 'field', -1, 200004) as Region).id, 'big/body/x');
});

test('outline contour of a multi-row range', () => {
  // Bytes 10..37 at 16 per row: rows 0 (10..15), 1 (0..15), 2 (0..5).
  const range = { start: 10, end: 38 };
  assert.deepEqual(rowContour(range, 16, 0), { a: 10, b: 15, top: [10, 15], bottom: undefined });
  assert.deepEqual(rowContour(range, 16, 1), { a: 0, b: 15, top: [0, 9], bottom: [6, 15] });
  assert.deepEqual(rowContour(range, 16, 2), { a: 0, b: 5, top: undefined, bottom: [0, 5] });
  assert.equal(rowContour(range, 16, 3), undefined);
  assert.deepEqual(rowContour({ start: 3, end: 5 }, 16, 0), { a: 3, b: 4, top: [3, 4], bottom: [3, 4] });
});
