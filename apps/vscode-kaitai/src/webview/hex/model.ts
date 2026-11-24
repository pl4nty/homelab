// Pure logic for the Kaitai hex editor: layout maths, scroll mapping, region colouring and
// gap/field stepping. No DOM and no `vscode` import, so the extension host, the webview and the
// unit tests can all use it.
import type { Region, StructureNode } from '../../engine/structure.ts';

export interface Range {
  start: number;
  end: number;
}

// ---------------------------------------------------------------------------------------------
// Rows and offsets

export function rowCount(size: number, bytesPerRow: number): number {
  return Math.max(1, Math.ceil(size / bytesPerRow));
}

/** Hex digits for the offset column: enough for the last offset, at least 4, always even. */
export function offsetDigits(size: number): number {
  const last = Math.max(0, size - 1);
  const digits = last === 0 ? 1 : Math.floor(Math.log2(last) / 4) + 1;
  return Math.max(4, digits + (digits % 2));
}

export function hex(n: number, width = 0): string {
  return n.toString(16).toUpperCase().padStart(width, '0');
}

const HEX2: string[] = Array.from({ length: 256 }, (_, i) => hex(i, 2));
export function hexByte(b: number): string {
  return HEX2[b];
}

/** Printable in the ASCII column (as the Web IDE: <32, 0x7f-0xa0 and 0xad are not). */
export function isPrintable(b: number): boolean {
  return b >= 0x20 && b < 0x7f;
}

export function asciiChar(b: number): string {
  return isPrintable(b) ? String.fromCharCode(b) : '.';
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** `0x1A (26)` */
export function formatOffset(n: number): string {
  return `0x${hex(n)} (${n})`;
}

// ---------------------------------------------------------------------------------------------
// Horizontal layout, in character cells. The renderer multiplies by the measured char width.

export interface Columns {
  bytesPerRow: number;
  /** Width of the offset column including its right padding. */
  offsetChars: number;
  /** x (chars) of the first hex cell. */
  hexStart: number;
  /** x (chars) of the ASCII column. */
  asciiStart: number;
  /** Total width (chars). */
  width: number;
}

/** Each hex cell is 3 chars ("AB "), with one extra char after every 8 bytes. */
export function columns(size: number, bytesPerRow: number): Columns {
  const offsetChars = offsetDigits(size) + 2;
  const hexStart = offsetChars;
  const groups = Math.ceil(bytesPerRow / 8);
  const hexWidth = bytesPerRow * 3 + (groups - 1);
  const asciiStart = hexStart + hexWidth + 1;
  return { bytesPerRow, offsetChars, hexStart, asciiStart, width: asciiStart + bytesPerRow + 1 };
}

/** x (chars) of the hex cell for column `col` (0-based byte within the row). */
export function hexCellX(c: Columns, col: number): number {
  return c.hexStart + col * 3 + Math.floor(col / 8);
}

export function asciiCellX(c: Columns, col: number): number {
  return c.asciiStart + col;
}

/**
 * Byte column under x (in chars, fractional). Returns the area too. Clicks in the gaps snap to the
 * nearest cell; clicks left of the hex area give column 0 and right of the ASCII area the last column.
 */
export function hitColumn(c: Columns, x: number): { col: number; area: 'offset' | 'hex' | 'ascii' } {
  const n = c.bytesPerRow;
  if (x < c.hexStart - 0.5) return { col: 0, area: 'offset' };
  const hexEnd = hexCellX(c, n - 1) + 2;
  if (x < (hexEnd + c.asciiStart) / 2) {
    // Find the cell whose [x, x+3) span contains x, accounting for the group gaps.
    let rel = x - c.hexStart;
    const group = clamp(Math.floor(rel / 25), 0, Math.ceil(n / 8) - 1);
    rel -= group * 25;
    const inGroup = clamp(Math.floor(rel / 3), 0, 7);
    return { col: clamp(group * 8 + inGroup, 0, n - 1), area: 'hex' };
  }
  return { col: clamp(Math.floor(x - c.asciiStart), 0, n - 1), area: 'ascii' };
}

// ---------------------------------------------------------------------------------------------
// Vertical scrolling. Browsers cap element heights (about 33M px in Chromium), so for big files
// the scroll spacer is capped and the native scrollTop maps proportionally to a virtual offset.

export const MAX_SPACER = 8_000_000;

export interface ScrollModel {
  /** Total content height in virtual pixels (rows * rowHeight). */
  total: number;
  /** Height of the visible rows area. */
  view: number;
  /** Height of the DOM spacer (capped). */
  spacer: number;
  /** Largest virtual scroll offset. */
  maxVirtual: number;
  /** Largest native scrollTop. */
  maxNative: number;
  scaled: boolean;
}

export function scrollModel(rows: number, rowHeight: number, view: number, cap = MAX_SPACER): ScrollModel {
  const total = rows * rowHeight;
  const spacer = Math.min(total, cap);
  return {
    total,
    view,
    spacer,
    maxVirtual: Math.max(0, total - view),
    maxNative: Math.max(0, spacer - view),
    scaled: total > cap,
  };
}

export function nativeToVirtual(m: ScrollModel, scrollTop: number): number {
  if (!m.scaled) return clamp(scrollTop, 0, m.maxVirtual);
  if (m.maxNative <= 0) return 0;
  return clamp((scrollTop / m.maxNative) * m.maxVirtual, 0, m.maxVirtual);
}

export function virtualToNative(m: ScrollModel, virtual: number): number {
  if (!m.scaled) return clamp(virtual, 0, m.maxNative);
  if (m.maxVirtual <= 0) return 0;
  return clamp((virtual / m.maxVirtual) * m.maxNative, 0, m.maxNative);
}

/** First row (possibly partly visible) and the pixel offset of its top edge (<= 0). */
export function visibleRows(virtual: number, rowHeight: number, view: number, rows: number) {
  const first = Math.floor(virtual / rowHeight);
  const y0 = first * rowHeight - virtual;
  const count = Math.min(rows - first, Math.ceil((view - y0) / rowHeight));
  return { first, y0, count: Math.max(0, count) };
}

/** New virtual offset that brings `row` fully into view (unchanged if already visible). */
export function scrollToRow(virtual: number, row: number, rowHeight: number, view: number, center = false): number {
  const top = row * rowHeight;
  if (center) return Math.max(0, top - Math.max(0, (view - rowHeight) / 2));
  if (top < virtual) return top;
  if (top + rowHeight > virtual + view) return Math.max(0, top + rowHeight - view);
  return virtual;
}

// ---------------------------------------------------------------------------------------------
// Selection

export interface Selection {
  /** Where a drag or shift-extend started. */
  anchor: number;
  /** The byte under the caret. */
  caret: number;
  /** false: only a caret, no bytes selected. */
  active: boolean;
}

/** Exclusive byte range of the selection; start === end for a bare caret. */
export function selectionRange(s: Selection): Range {
  if (!s.active) return { start: s.caret, end: s.caret };
  return { start: Math.min(s.anchor, s.caret), end: Math.max(s.anchor, s.caret) + 1 };
}

// ---------------------------------------------------------------------------------------------
// Region colouring

/** Hue families. Adjacent nesting levels use different families. */
export const HUES = 6;
/** Tone variants per hue: two alternating tones plus a third used to break rare ties. */
export const TONES = 3;

/**
 * Colour key of a leaf from its path of sibling indices (root first). Siblings are counted among
 * ranged, non-instance children, with array buckets flattened, so consecutive ranged fields of one
 * struct differ in tone, and leaves of sibling structs differ in hue.
 */
export function colourKey(path: readonly number[]): number {
  const d = path.length - 1;
  if (d <= 0) return 0;
  const tone = path[d] & 1;
  const hue = ((d - 1) * 2 + (path[d - 1] & 1)) % HUES;
  return hue * TONES + tone;
}

export function keyHue(key: number): number {
  return Math.floor(key / TONES) % HUES;
}

export function keyTone(key: number): number {
  return key % TONES;
}

/**
 * Final colour per region (sorted by start). A region touching its predecessor with the same key
 * gets the third tone. Only the predecessor's own key is used, so colours do not depend on which
 * part of the file was loaded first.
 */
export function assignColours(regions: readonly Region[], keys: readonly number[]): number[] {
  const out = new Array<number>(regions.length);
  for (let i = 0; i < regions.length; i++) {
    const k = keys[i] ?? 0;
    const prev = i > 0 ? regions[i - 1] : undefined;
    out[i] = prev && prev.end === regions[i].start && keys[i - 1] === k ? k - keyTone(k) + 2 : k;
  }
  return out;
}

export interface KeyedRegions {
  regions: Region[];
  keys: number[];
}

/**
 * Same regions as `regionsInRange` from engine/structure.ts, plus a colour key for each (see
 * test/hex.test.ts). One deliberate difference: a struct is reported as a region of its own only
 * when none of its fields has a range (they were read from a processed stream), not whenever
 * none of them falls inside the window, so the result does not depend on the window.
 */
export function keyedRegionsInRange(roots: StructureNode[], start: number, end: number, limit = 20000): KeyedRegions {
  const items: { r: Region; k: number }[] = [];
  const path: number[] = [];
  const visit = (node: StructureNode, depth: number) => {
    if (items.length >= limit) return;
    const r = node.range;
    if (r && (r.end <= start || r.start >= end)) return;
    if (node.hasChildren && node.kind !== 'bytes') {
      let index = 0;
      let rangedChild = false;
      const walk = (children: StructureNode[], d: number) => {
        for (const child of children) {
          if (child.instance) continue;
          if (child.range) rangedChild = true;
          if (child.kind === 'bucket') {
            // Buckets are a display device of the tree: colour array items as one sequence.
            const cr = child.range;
            if (!cr || (cr.end > start && cr.start < end)) walk(child.children(), d + 1);
            continue;
          }
          // Array items carry their absolute index, which keeps parity stable across buckets.
          const item = /^\[(\d+)\]$/.exec(child.name);
          path.push(item ? Number(item[1]) : index);
          visit(child, d);
          path.pop();
          if (child.range && child.range.end > child.range.start) index++;
        }
      };
      walk(node.children(), depth + 1);
      // A struct whose fields all live in a processed stream still covers its raw bytes. (Unlike
      // regionsInRange, a struct whose fields merely lie outside the window does not count.)
      if (!rangedChild && r && r.end > r.start) items.push({ r: region(node, depth), k: colourKey(path) });
      return;
    }
    if (r && r.end > r.start) items.push({ r: region(node, depth), k: colourKey(path) });
  };
  roots.forEach((root, i) => {
    path.push(i);
    visit(root, 0);
    path.pop();
  });
  items.sort((a, b) => a.r.start - b.r.start || b.r.end - a.r.end);
  return { regions: items.map((x) => x.r), keys: items.map((x) => x.k) };
}

function region(node: StructureNode, depth: number): Region {
  return {
    start: node.range!.start,
    end: node.range!.end,
    id: node.id,
    depth,
    label: node.value === undefined ? node.id : `${node.id} = ${node.value}`,
    error: node.error !== undefined || undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// Lookups over a sorted region list

/** Index of the smallest region containing `offset`, or -1. Regions are sorted by start. */
export function regionAt(regions: readonly Region[], offset: number): number {
  // Last region with start <= offset, then scan back for containment (leaves rarely overlap).
  let lo = 0;
  let hi = regions.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (regions[mid].start <= offset) lo = mid + 1;
    else hi = mid;
  }
  let best = -1;
  for (let i = lo - 1, scanned = 0; i >= 0 && scanned < 64; i--, scanned++) {
    const r = regions[i];
    if (r.start <= offset && offset < r.end) {
      if (best < 0 || r.end - r.start < regions[best].end - regions[best].start) best = i;
    }
  }
  return best;
}

/**
 * Bytes in [start, end) that no region covers. `coveredEnd` limits the search when the region
 * list was truncated: nothing at or after it is reported.
 */
export function gapsIn(regions: readonly Region[], start: number, end: number, coveredEnd = end): Range[] {
  const out: Range[] = [];
  const stop = Math.min(end, coveredEnd);
  let pos = start;
  for (const r of regions) {
    if (r.end <= pos) continue;
    if (r.start >= stop) break;
    if (r.start > pos) out.push({ start: pos, end: r.start });
    pos = Math.max(pos, r.end);
    if (pos >= stop) break;
  }
  if (pos < stop) out.push({ start: pos, end: stop });
  return out;
}

/** First gap that starts after `from`. Gaps must be sorted. */
export function nextGap(gaps: readonly Range[], from: number): Range | undefined {
  return gaps.find((g) => g.start > from);
}

/** Last gap that starts before `from`. */
export function prevGap(gaps: readonly Range[], from: number): Range | undefined {
  for (let i = gaps.length - 1; i >= 0; i--) if (gaps[i].start < from) return gaps[i];
  return undefined;
}

/** First region that starts after `from`. */
export function nextField(regions: readonly Region[], from: number): Region | undefined {
  let best: Region | undefined;
  for (const r of regions) {
    if (r.start > from && (!best || r.start < best.start)) best = r;
    if (best && r.start > best.start) break;
  }
  return best;
}

/** Last region that starts before `from`. */
export function prevField(regions: readonly Region[], from: number): Region | undefined {
  let best: Region | undefined;
  for (const r of regions) {
    if (r.start >= from) break;
    if (!best || r.start >= best.start) best = r;
  }
  return best;
}

/** Merges region lists (each sorted), dropping duplicates of the same node and range. */
export function mergeRegions(lists: readonly KeyedRegions[]): KeyedRegions {
  const seen = new Set<string>();
  const items: { r: Region; k: number }[] = [];
  for (const l of lists) {
    l.regions.forEach((r, i) => {
      const id = `${r.start}:${r.end}:${r.id}`;
      if (seen.has(id)) return;
      seen.add(id);
      items.push({ r, k: l.keys[i] ?? 0 });
    });
  }
  items.sort((a, b) => a.r.start - b.r.start || b.r.end - a.r.end);
  return { regions: items.map((x) => x.r), keys: items.map((x) => x.k) };
}

// ---------------------------------------------------------------------------------------------
// Steppers (run in the extension host, which has the tree)

const STEP_CHUNK = 1 << 16;
const STEP_LIMIT = 20000;

/** Regions of [start, end), halving the window until the list is not truncated. */
function regionsChunk(roots: StructureNode[], start: number, end: number, fromEnd: boolean) {
  for (;;) {
    const { regions } = keyedRegionsInRange(roots, start, end, STEP_LIMIT);
    if (regions.length < STEP_LIMIT || end - start <= 64) return { regions, start, end };
    const half = Math.max(1, Math.floor((end - start) / 2));
    if (fromEnd) start = end - half;
    else end = start + half;
  }
}

/** Maximal unparsed gaps from `from` towards the end of the file, in order. */
export function* gapsForward(roots: StructureNode[], size: number, from: number): Generator<Range> {
  let open: Range | undefined;
  for (let cs = from; cs < size; ) {
    const chunk = regionsChunk(roots, cs, Math.min(size, cs + STEP_CHUNK), false);
    for (const g of gapsIn(chunk.regions, chunk.start, chunk.end)) {
      if (open && g.start === open.end) {
        open.end = g.end;
        continue;
      }
      if (open) yield open;
      open = { ...g };
    }
    cs = chunk.end;
    if (open && open.end < cs) {
      yield open;
      open = undefined;
    }
  }
  if (open) yield open;
}

/** Maximal unparsed gaps ending at or before `from`, nearest first. */
export function* gapsBackward(roots: StructureNode[], from: number): Generator<Range> {
  let open: Range | undefined;
  for (let ce = from; ce > 0; ) {
    const chunk = regionsChunk(roots, Math.max(0, ce - STEP_CHUNK), ce, true);
    const gaps = gapsIn(chunk.regions, chunk.start, chunk.end);
    for (let i = gaps.length - 1; i >= 0; i--) {
      const g = gaps[i];
      if (open && g.end === open.start) {
        open.start = g.start;
        continue;
      }
      if (open) yield open;
      open = { ...g };
    }
    ce = chunk.start;
    if (open && open.start > ce) {
      yield open;
      open = undefined;
    }
  }
  if (open) yield open;
}

/**
 * Next (direction 1) or previous (-1) unparsed gap or field relative to `from` (the selection
 * start). Gaps are maximal runs of bytes that no leaf field covers, as in the Web IDE's stepper.
 */
export function findStep(
  roots: StructureNode[],
  size: number,
  what: 'gap' | 'field',
  direction: 1 | -1,
  from: number,
): Region | Range | undefined {
  if (what === 'gap') {
    if (direction > 0) {
      for (const g of gapsForward(roots, size, from)) if (g.start > from) return g;
      return undefined;
    }
    const g = gapsBackward(roots, from).next().value;
    if (!g) return undefined;
    // The gap may continue past `from` (the caret was inside it).
    if (g.end === from) {
      const rest = gapsForward(roots, size, from).next().value;
      if (rest && rest.start === from) g.end = rest.end;
    }
    return g;
  }
  if (direction > 0) {
    for (let cs = from; cs < size; ) {
      const chunk = regionsChunk(roots, cs, Math.min(size, cs + STEP_CHUNK), false);
      const r = nextField(chunk.regions, from);
      if (r) return r;
      cs = chunk.end;
    }
    return undefined;
  }
  for (let ce = from; ce > 0; ) {
    const chunk = regionsChunk(roots, Math.max(0, ce - STEP_CHUNK), ce, true);
    const r = prevField(chunk.regions, from);
    if (r) return r;
    ce = chunk.start;
  }
  return undefined;
}

/**
 * Outline of a byte range on one row, as column spans: the row's span [a, b] (both edges get
 * vertical lines), and the parts of it that need a top or bottom edge so that a multi-row range
 * is drawn as one contour rather than one box per row.
 */
export function rowContour(range: Range, bytesPerRow: number, row: number) {
  const firstRow = Math.floor(range.start / bytesPerRow);
  const lastRow = Math.floor((range.end - 1) / bytesPerRow);
  if (range.end <= range.start || row < firstRow || row > lastRow) return undefined;
  const a = row === firstRow ? range.start % bytesPerRow : 0;
  const b = row === lastRow ? (range.end - 1) % bytesPerRow : bytesPerRow - 1;
  // The row above covers [prevA, bpr-1]; the row below covers [0, nextB].
  const prevA = row - 1 === firstRow ? range.start % bytesPerRow : 0;
  const nextB = row + 1 === lastRow ? (range.end - 1) % bytesPerRow : bytesPerRow - 1;
  const top: [number, number] | undefined =
    row === firstRow ? [a, b] : a < prevA ? [a, Math.min(b, prevA - 1)] : undefined;
  const bottom: [number, number] | undefined =
    row === lastRow ? [a, b] : b > nextB ? [Math.max(a, nextB + 1), b] : undefined;
  return { a, b, top, bottom };
}
