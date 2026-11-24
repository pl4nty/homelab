// Pure logic for the Kaitai hex editor: layout maths, scroll mapping, region colouring and
// gap/field stepping. No DOM and no `vscode` import, so the extension host, the webview and the
// unit tests can all use it.
import { type ByteRange, type Region, regionsInRange, type StructureNode, TONES } from '../../engine/structure.ts';

export type Range = ByteRange;

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

/** Shown as itself in the ASCII column; other bytes are drawn as a dimmed dot. */
export function isPrintable(b: number): boolean {
  return b >= 0x20 && b < 0x7f;
}

export function asciiChar(b: number): string {
  return isPrintable(b) ? String.fromCharCode(b) : '.';
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(v, hi));
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
// Regions: sorted lists from `regionsInRange`

/**
 * Final palette index per region. A region touching its predecessor with the same key gets the
 * third tone. Only the predecessor's own key is used, so colours do not depend on which part of
 * the file was loaded first.
 */
export function assignColours(regions: readonly Region[]): number[] {
  return regions.map((r, i) => {
    const prev = regions[i - 1];
    return prev?.end === r.start && prev.key === r.key ? r.key - (r.key % TONES) + TONES - 1 : r.key;
  });
}

/** Merges region lists, dropping duplicates of the same node and range (blocks overlap). */
export function mergeRegions(lists: readonly Region[][]): Region[] {
  const byId = new Map<string, Region>();
  for (const r of lists.flat()) byId.set(`${r.start}:${r.end}:${r.id}`, r);
  return [...byId.values()].sort((a, b) => a.start - b.start || b.end - a.end);
}

/** The smallest region containing `offset`. */
export function regionAt(regions: readonly Region[], offset: number): Region | undefined {
  // Last region with start <= offset, then scan back for containment (leaves rarely overlap).
  let lo = 0;
  let hi = regions.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (regions[mid].start <= offset) lo = mid + 1;
    else hi = mid;
  }
  let best: Region | undefined;
  for (let i = lo - 1; i >= Math.max(0, lo - 64); i--) {
    const r = regions[i];
    if (offset < r.end && (!best || r.end - r.start < best.end - best.start)) best = r;
  }
  return best;
}

/** Bytes in [start, end) that no region covers. */
export function gapsIn(regions: readonly Region[], start: number, end: number): Range[] {
  const out: Range[] = [];
  let pos = start;
  for (const r of regions) {
    if (r.start >= end) break;
    if (r.start > pos) out.push({ start: pos, end: r.start });
    pos = Math.max(pos, r.end);
  }
  if (pos < end) out.push({ start: pos, end });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Steppers (run in the extension host, which has the tree)

const STEP_CHUNK = 1 << 16;
const STEP_LIMIT = 20000;

interface Chunk extends Range {
  regions: Region[];
}

/**
 * Walks the file from `from` towards its end (direction 1) or its start (-1) in windows whose
 * region lists are complete: a window is halved until its list is under the limit.
 */
function* chunks(roots: StructureNode[], size: number, from: number, direction: 1 | -1): Generator<Chunk> {
  for (let pos = from; direction > 0 ? pos < size : pos > 0; ) {
    let start = direction > 0 ? pos : Math.max(0, pos - STEP_CHUNK);
    let end = direction > 0 ? Math.min(size, pos + STEP_CHUNK) : pos;
    let regions = regionsInRange(roots, start, end, STEP_LIMIT);
    while (regions.length >= STEP_LIMIT && end - start > 64) {
      const half = (end - start) >> 1;
      if (direction > 0) end = start + half;
      else start = end - half;
      regions = regionsInRange(roots, start, end, STEP_LIMIT);
    }
    yield { regions, start, end };
    pos = direction > 0 ? end : start;
  }
}

/** Maximal unparsed gaps, nearest first: from `from` onwards, or (direction -1) ending at or before it. */
function* gaps(roots: StructureNode[], size: number, from: number, direction: 1 | -1): Generator<Range> {
  let open: Range | undefined;
  for (const chunk of chunks(roots, size, from, direction)) {
    const found = gapsIn(chunk.regions, chunk.start, chunk.end);
    for (const g of direction > 0 ? found : found.reverse()) {
      // A gap that continues the open one across the chunk edge is the same gap.
      if (open && direction > 0 && g.start === open.end) open.end = g.end;
      else if (open && direction < 0 && g.end === open.start) open.start = g.start;
      else {
        if (open) yield open;
        open = g;
      }
    }
    // Finished unless it reaches the far edge of the chunk, where the next chunk may extend it.
    if (open && (direction > 0 ? open.end < chunk.end : open.start > chunk.start)) {
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
): Range | undefined {
  if (what === 'field') {
    for (const chunk of chunks(roots, size, from, direction)) {
      // Backwards, a field that starts before the chunk is left to the chunk it starts in: a
      // later-starting field may lie wholly before this one.
      const r =
        direction > 0
          ? chunk.regions.find((r) => r.start > from)
          : chunk.regions.filter((r) => r.start < from && r.start >= chunk.start).pop();
      if (r) return { start: r.start, end: r.end };
    }
    return undefined;
  }
  if (direction > 0) {
    for (const g of gaps(roots, size, from, 1)) if (g.start > from) return g;
    return undefined;
  }
  const g = gaps(roots, size, from, -1).next().value;
  // The gap may continue past `from` (the caret was inside it).
  if (g?.end === from) {
    const rest = gaps(roots, size, from, 1).next().value;
    if (rest?.start === from) g.end = rest.end;
  }
  return g;
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
