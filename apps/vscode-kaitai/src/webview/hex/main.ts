// Kaitai hex editor webview: a virtualised, canvas-drawn hex view with field colouring.
import './hex.css';
import type { FromHex, Region, ToHex } from '../../shared/protocol.ts';
import {
  asciiCellX,
  asciiChar,
  assignColours,
  type Columns,
  clamp,
  columns,
  formatOffset,
  HUES,
  hex,
  hexByte,
  hexCellX,
  hitColumn,
  type KeyedRegions,
  mergeRegions,
  nativeToVirtual,
  offsetDigits,
  type Range,
  regionAt,
  rowContour,
  rowCount,
  type ScrollModel,
  type Selection,
  scrollModel,
  scrollToRow,
  selectionRange,
  TONES,
  virtualToNative,
  visibleRows,
} from './model.ts';

interface VsCodeApi {
  postMessage(message: FromHex): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

interface SavedState {
  fileName: string;
  topOffset: number;
  sel: Selection;
}

const vscode = acquireVsCodeApi();
const post = (m: FromHex) => vscode.postMessage(m);

/** Bytes per region request. Small enough that dense u1 fields stay under the host's limit. */
const BLOCK = 8192;
const MAX_BLOCKS = 96;
const HUE_DEGREES = [210, 140, 30, 280, 180, 330];

// ---------------------------------------------------------------------------------------------
// DOM

const app = document.getElementById('app') ?? document.body.appendChild(document.createElement('div'));
app.id = 'app';
app.tabIndex = 0;
const view = el('div', 'view', app);
const scroller = el('div', 'scroller', view);
const spacer = el('div', 'spacer', scroller);
const canvas = el('canvas', 'grid', view);
const tooltip = el('div', 'tooltip', view);
tooltip.hidden = true;
const status = el('div', 'status', app);
const stPos = el('button', 'pos', status);
stPos.title = 'Go to Offset… (Ctrl+G)';
const stSel = el('span', 'sel', status);
const stField = el('span', 'field', status);
el('span', 'spring', status);
const stNote = el('span', 'note', status);
const stError = el('span', 'error', status);
const stSpec = el('button', 'spec', status);
stSpec.textContent = 'Load Spec…';
stSpec.title = 'Choose a .ksy spec to parse this file with';
const ctx = canvas.getContext('2d', { alpha: false })!;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  parent.appendChild(e);
  return e;
}

// ---------------------------------------------------------------------------------------------
// State

let data: Uint8Array = new Uint8Array(0);
let fileName = '';
let bpr = 16;
let cols: Columns = columns(0, bpr);
let rows = 1;
let sel: Selection = { anchor: 0, caret: 0, active: false };
let virtual = 0;
let lastNative = -1;
let model: ScrollModel = scrollModel(1, 20, 100);
let version = -1;
let hasSpec = false;
let parseError: string | undefined;
let highlight: Range | undefined;
let hoverOffset = -1;
let note = '';
let noteTimer: ReturnType<typeof setTimeout> | undefined;
let initialised = false;

// Metrics, refreshed on theme or font changes.
let cw = 8;
let rowH = 20;
let headerH = 20;
let font = '13px monospace';
let dpr = 1;

interface Theme {
  bg: string;
  fg: string;
  muted: string;
  activeLine: string;
  border: string;
  selBg: string;
  selFg: string;
  inactiveSelBg: string;
  caret: string;
  error: string;
  highlight: string;
  highlightBg: string;
  hover: string;
  boundary: string;
  boundaryAlpha: number;
  palette: string[];
}
let theme: Theme = readTheme();

// Region cache: block index -> keyed regions for [i*BLOCK, (i+1)*BLOCK).
const blocks = new Map<number, KeyedRegions>();
const pendingBlocks = new Set<number>();
let windowRegions: Region[] = [];
let windowColours: number[] = [];
let windowKey = '';

let nextRequestId = 1;
const pending = new Map<number, (m: ToHex) => void>();

// ---------------------------------------------------------------------------------------------
// Theme and metrics

function cssVar(name: string, fallback = '') {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function themeKind(): 'light' | 'dark' | 'hc' | 'hcLight' {
  const c = document.body.classList;
  if (c.contains('vscode-high-contrast-light')) return 'hcLight';
  if (c.contains('vscode-high-contrast')) return 'hc';
  if (c.contains('vscode-light')) return 'light';
  if (c.contains('vscode-dark')) return 'dark';
  // Outside VS Code (tests): guess from the background.
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function readTheme(): Theme {
  const kind = themeKind();
  const fg = cssVar('--vscode-editor-foreground', kind === 'light' || kind === 'hcLight' ? '#333' : '#ccc');
  const alphas =
    kind === 'hc' || kind === 'hcLight' ? [0.34, 0.52, 0.7] : kind === 'light' ? [0.15, 0.3, 0.45] : [0.2, 0.36, 0.52];
  const light = kind === 'light' || kind === 'hcLight' ? 48 : 58;
  const palette: string[] = [];
  for (let h = 0; h < HUES; h++) {
    for (let t = 0; t < TONES; t++) palette.push(`hsla(${HUE_DEGREES[h]}, 70%, ${light}%, ${alphas[t]})`);
  }
  const focus = cssVar('--vscode-focusBorder', '#0078d4');
  return {
    bg: cssVar('--vscode-editor-background', kind === 'light' ? '#fff' : '#1e1e1e'),
    fg,
    muted: cssVar('--vscode-editorLineNumber-foreground', cssVar('--vscode-descriptionForeground', '#858585')),
    activeLine: cssVar('--vscode-editorLineNumber-activeForeground', fg),
    border: cssVar('--vscode-editorGroup-border', cssVar('--vscode-panel-border', 'rgba(128,128,128,0.35)')),
    selBg: cssVar('--vscode-editor-selectionBackground', '#264f78'),
    selFg: cssVar('--vscode-editor-selectionForeground', fg),
    inactiveSelBg: cssVar('--vscode-editor-inactiveSelectionBackground', 'rgba(128,128,128,0.35)'),
    caret: cssVar('--vscode-editorCursor-foreground', fg),
    error: cssVar('--vscode-editorError-foreground', '#f14c4c'),
    highlight: cssVar('--vscode-editor-findMatchHighlightBorder', '') || focus,
    highlightBg: cssVar('--vscode-editor-findMatchHighlightBackground', 'rgba(234,92,0,0.33)'),
    hover: cssVar('--vscode-editorHoverWidget-border', '') || focus,
    boundary: fg,
    boundaryAlpha: kind === 'hc' || kind === 'hcLight' ? 0.9 : 0.35,
    palette,
  };
}

function readMetrics() {
  const family = cssVar('--vscode-editor-font-family', 'Consolas, "Courier New", monospace');
  const size = Number.parseFloat(cssVar('--vscode-editor-font-size', '13')) || 13;
  font = `${size}px ${family}`;
  ctx.font = font;
  cw = ctx.measureText('0').width || size * 0.6;
  rowH = Math.ceil(size * 1.5);
  headerH = rowH + 2;
}

// ---------------------------------------------------------------------------------------------
// Layout and scrolling

function relayout() {
  cols = columns(data.byteLength, bpr);
  rows = rowCount(data.byteLength, bpr);
  const viewH = Math.max(0, scroller.clientHeight - headerH);
  model = scrollModel(rows, rowH, viewH);
  spacer.style.height = `${model.spacer + headerH}px`;
  spacer.style.width = `${Math.ceil((cols.width + 1) * cw)}px`;
  const w = scroller.clientWidth;
  const h = scroller.clientHeight;
  dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }
  setVirtual(virtual);
}

function setVirtual(v: number) {
  virtual = clamp(v, 0, model.maxVirtual);
  const native = virtualToNative(model, virtual);
  if (Math.abs(scroller.scrollTop - native) >= 1) scroller.scrollTop = native;
  lastNative = scroller.scrollTop;
  schedule();
  saveState();
}

scroller.addEventListener('scroll', () => {
  const t = scroller.scrollTop;
  // Our own scrollTop writes come back as scroll events; keep the precise virtual offset then.
  if (Math.abs(t - lastNative) >= 1) {
    virtual = nativeToVirtual(model, t);
    lastNative = t;
    saveState();
  }
  hideTooltip();
  schedule();
});

scroller.addEventListener(
  'wheel',
  (e) => {
    if (!model.scaled || e.ctrlKey) return;
    // In scaled mode one native pixel spans many rows; scroll by real pixels instead.
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * rowH : e.deltaMode === 2 ? e.deltaY * model.view : e.deltaY;
    const dx = e.deltaMode === 1 ? e.deltaX * cw : e.deltaX;
    if (dx) scroller.scrollLeft += dx;
    setVirtual(virtual + dy);
  },
  { passive: false },
);

new ResizeObserver(() => {
  relayout();
}).observe(view);

function pageRows() {
  return Math.max(1, Math.floor(model.view / rowH) - 1);
}

function revealOffset(offset: number, center = false) {
  const row = Math.floor(offset / bpr);
  const vis = visibleRows(virtual, rowH, model.view, rows);
  const far = row < vis.first || row > vis.first + vis.count;
  setVirtual(scrollToRow(virtual, row, rowH, model.view, center && far));
}

// ---------------------------------------------------------------------------------------------
// Regions

function request(m: { start: number; end: number }): Promise<ToHex> {
  const requestId = nextRequestId++;
  return new Promise((resolve) => {
    pending.set(requestId, resolve);
    post({ type: 'requestRegions', requestId, start: m.start, end: m.end });
  });
}

function find(what: 'gap' | 'field', direction: 1 | -1, from: number): Promise<ToHex> {
  const requestId = nextRequestId++;
  return new Promise((resolve) => {
    pending.set(requestId, resolve);
    post({ type: 'find', requestId, what, direction, from });
  });
}

function dropRegions() {
  blocks.clear();
  pendingBlocks.clear();
  windowKey = '';
  windowRegions = [];
  windowColours = [];
}

/** Makes sure regions for the visible bytes (plus a block either side) are loaded or on the way. */
function ensureRegions(first: number, count: number) {
  if (!hasSpec || data.byteLength === 0) {
    windowRegions = [];
    windowColours = [];
    return;
  }
  const vs = first * bpr;
  const ve = Math.min(data.byteLength, (first + count) * bpr);
  const b0 = Math.max(0, Math.floor(vs / BLOCK) - 1);
  const b1 = Math.min(Math.floor((data.byteLength - 1) / BLOCK), Math.floor(Math.max(vs, ve - 1) / BLOCK) + 1);
  let loaded = 0;
  for (let b = b0; b <= b1; b++) {
    if (blocks.has(b)) {
      loaded++;
      continue;
    }
    if (pendingBlocks.has(b)) continue;
    pendingBlocks.add(b);
    const v = version;
    void request({ start: b * BLOCK, end: Math.min(data.byteLength, (b + 1) * BLOCK) }).then((m) => {
      if (m.type !== 'regions' || m.version !== version || v !== version) return;
      pendingBlocks.delete(b);
      blocks.set(b, { regions: m.regions, keys: m.keys ?? m.regions.map(() => 0) });
      evict(b);
      schedule();
    });
  }
  const key = `${version}:${b0}:${b1}:${loaded}`;
  if (key === windowKey) return;
  windowKey = key;
  const lists: KeyedRegions[] = [];
  for (let b = b0; b <= b1; b++) {
    const l = blocks.get(b);
    if (l) lists.push(l);
  }
  const merged = mergeRegions(lists);
  windowRegions = merged.regions;
  windowColours = assignColours(merged.regions, merged.keys);
}

function evict(near: number) {
  if (blocks.size <= MAX_BLOCKS) return;
  const far = [...blocks.keys()].sort((a, b) => Math.abs(b - near) - Math.abs(a - near));
  for (const b of far.slice(0, blocks.size - MAX_BLOCKS)) blocks.delete(b);
  windowKey = '';
}

function regionIndexAt(offset: number) {
  return regionAt(windowRegions, offset);
}

// ---------------------------------------------------------------------------------------------
// Rendering

let frame = 0;
function schedule() {
  if (!frame) frame = requestAnimationFrame(render);
}

function render() {
  frame = 0;
  if (!initialised) return;
  const W = scroller.clientWidth;
  const H = scroller.clientHeight;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.font = font;
  ctx.textBaseline = 'middle';

  const size = data.byteLength;
  const vis = visibleRows(virtual, rowH, model.view, rows);
  ensureRegions(vis.first, vis.count);
  const sx = scroller.scrollLeft;
  const vs = vis.first * bpr;
  const ve = Math.min(size, (vis.first + vis.count) * bpr);
  const focused = document.hasFocus() && document.activeElement === app;

  // Region index of each visible byte; later (narrower) regions overwrite wider ones.
  const cell = new Int32Array(Math.max(0, ve - vs)).fill(-1);
  for (let i = 0; i < windowRegions.length; i++) {
    const r = windowRegions[i];
    if (r.end <= vs || r.start >= ve) continue;
    cell.fill(i, Math.max(r.start, vs) - vs, Math.min(r.end, ve) - vs);
  }
  const range = selectionRange(sel);
  const selBg = focused ? theme.selBg : theme.inactiveSelBg;
  const digits = offsetDigits(size);
  const caretRow = Math.floor(sel.caret / bpr);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, headerH, W, H - headerH);
  ctx.clip();
  for (let r = 0; r < vis.count; r++) {
    const row = vis.first + r;
    const y = headerH + vis.y0 + r * rowH;
    const rowStart = row * bpr;
    const n = Math.min(bpr, size - rowStart);
    ctx.fillStyle = row === caretRow ? theme.activeLine : theme.muted;
    ctx.fillText(hex(rowStart, digits), cw * 0.5 - sx, y + rowH / 2);
    for (let c = 0; c < n; c++) {
      const off = rowStart + c;
      const ri = cell[off - vs];
      const nextRi = c + 1 < n ? cell[off + 1 - vs] : -2;
      const hx = (hexCellX(cols, c) - 0.5) * cw - sx;
      const groupEnd = c % 8 === 7 && c + 1 < n;
      const ax = asciiCellX(cols, c) * cw - sx;
      if (ri >= 0) {
        const reg = windowRegions[ri];
        ctx.fillStyle = theme.palette[windowColours[ri]] ?? theme.palette[0];
        const w = 3 * cw + (groupEnd && nextRi === ri ? cw : 0);
        ctx.fillRect(hx, y, w, rowH);
        ctx.fillRect(ax, y, cw, rowH);
        if (reg.start === off && c > 0 && cell[off - 1 - vs] >= 0) {
          // Boundary between two adjacent fields.
          ctx.globalAlpha = theme.boundaryAlpha;
          ctx.fillStyle = theme.boundary;
          ctx.fillRect(Math.round(hx), y + 2, 1, rowH - 4);
          ctx.fillRect(Math.round(ax), y + 2, 1, rowH - 4);
          ctx.globalAlpha = 1;
        }
        if (reg.error) {
          ctx.fillStyle = theme.error;
          ctx.fillRect(hx, y + rowH - 2, w, 2);
          ctx.fillRect(ax, y + rowH - 2, cw, 2);
        }
      }
      const selected = off >= range.start && off < range.end;
      if (selected) {
        ctx.fillStyle = selBg;
        const w = 3 * cw + (groupEnd && off + 1 < range.end ? cw : 0);
        ctx.fillRect(hx, y, w, rowH);
        ctx.fillRect(ax, y, cw, rowH);
      }
      const b = data[off];
      ctx.fillStyle = selected ? theme.selFg : theme.fg;
      if (b === 0 && !selected) ctx.globalAlpha = 0.5;
      ctx.fillText(hexByte(b), hx + 0.5 * cw, y + rowH / 2);
      if (b < 0x20 || b >= 0x7f) ctx.globalAlpha = selected ? 0.6 : 0.4;
      ctx.fillText(asciiChar(b), ax, y + rowH / 2);
      ctx.globalAlpha = 1;
    }
  }

  // Outlines: hovered field, highlight from the tree, caret.
  const hi = hoverOffset >= 0 ? regionIndexAt(hoverOffset) : -1;
  if (hi >= 0) outline(windowRegions[hi], theme.hover, 1, vis, sx);
  if (highlight && highlight.end > highlight.start) {
    ctx.globalAlpha = 0.5;
    fillRange(highlight, theme.highlightBg, vis, sx);
    ctx.globalAlpha = 1;
    outline(highlight, theme.highlight, 2, vis, sx);
  }
  if (size > 0 && caretRow >= vis.first && caretRow < vis.first + vis.count) {
    const c = sel.caret % bpr;
    const y = headerH + vis.y0 + (caretRow - vis.first) * rowH;
    ctx.strokeStyle = focused ? theme.caret : theme.muted;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round((hexCellX(cols, c) - 0.5) * cw - sx) + 0.5, y + 0.5, Math.round(3 * cw) - 1, rowH - 1);
    ctx.strokeRect(Math.round(asciiCellX(cols, c) * cw - sx) + 0.5, y + 0.5, Math.round(cw) - 1, rowH - 1);
  }
  ctx.restore();

  // Header with column offsets.
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, W, headerH);
  ctx.fillStyle = theme.muted;
  const caretCol = sel.caret % bpr;
  for (let c = 0; c < bpr; c++) {
    ctx.fillStyle = c === caretCol ? theme.activeLine : theme.muted;
    ctx.fillText(hexByte(c), hexCellX(cols, c) * cw - sx, headerH / 2);
    ctx.fillText(hex(c % 16), asciiCellX(cols, c) * cw - sx, headerH / 2);
  }
  ctx.fillStyle = theme.border;
  ctx.fillRect(0, headerH - 1, W, 1);
  ctx.fillRect(Math.round((cols.hexStart - 1) * cw - sx), 0, 1, H);
  ctx.fillRect(Math.round((cols.asciiStart - 1) * cw - sx), 0, 1, H);

  updateStatus();
}

/** Per-row rectangles of [range.start, range.end) in the hex and ASCII columns. */
function rowSpans(range: Range, vis: { first: number; count: number; y0: number }, sx: number) {
  const out: { x: number; w: number; y: number }[] = [];
  const size = data.byteLength;
  const first = Math.max(range.start, vis.first * bpr);
  const last = Math.min(range.end, size, (vis.first + vis.count) * bpr) - 1;
  for (let row = Math.floor(first / bpr); row <= Math.floor(last / bpr) && first <= last; row++) {
    const a = Math.max(first, row * bpr) % bpr;
    const b = Math.min(last, row * bpr + bpr - 1) % bpr;
    const y = headerH + vis.y0 + (row - vis.first) * rowH;
    const hx0 = (hexCellX(cols, a) - 0.5) * cw - sx;
    const hx1 = (hexCellX(cols, b) + 2.5) * cw - sx;
    out.push({ x: hx0, w: hx1 - hx0, y });
    out.push({ x: asciiCellX(cols, a) * cw - sx, w: (b - a + 1) * cw, y });
  }
  return out;
}

type Visible = { first: number; count: number; y0: number };

function outline(range: Range, colour: string, width: number, vis: Visible, sx: number) {
  ctx.fillStyle = colour;
  const size = data.byteLength;
  const r = { start: range.start, end: Math.min(range.end, size) };
  const hexL = (c: number) => Math.round((hexCellX(cols, c) - 0.5) * cw - sx);
  const hexR = (c: number) => Math.round((hexCellX(cols, c) + 2.5) * cw - sx);
  const ascL = (c: number) => Math.round(asciiCellX(cols, c) * cw - sx);
  const ascR = (c: number) => Math.round((asciiCellX(cols, c) + 1) * cw - sx);
  for (let i = 0; i < vis.count; i++) {
    const row = vis.first + i;
    const k = rowContour(r, bpr, row);
    if (!k) continue;
    const y = Math.round(headerH + vis.y0 + i * rowH);
    for (const [L, R] of [
      [hexL, hexR],
      [ascL, ascR],
    ]) {
      ctx.fillRect(L(k.a), y, width, rowH);
      ctx.fillRect(R(k.b) - width, y, width, rowH);
      if (k.top) ctx.fillRect(L(k.top[0]), y, R(k.top[1]) - L(k.top[0]), width);
      if (k.bottom) ctx.fillRect(L(k.bottom[0]), y + rowH - width, R(k.bottom[1]) - L(k.bottom[0]), width);
    }
  }
}

function fillRange(range: Range, colour: string, vis: { first: number; count: number; y0: number }, sx: number) {
  ctx.fillStyle = colour;
  for (const s of rowSpans(range, vis, sx)) ctx.fillRect(s.x, s.y, s.w, rowH);
}

function updateStatus() {
  const size = data.byteLength;
  stPos.textContent = size ? `Offset ${formatOffset(sel.caret)}` : 'Empty file';
  const r = selectionRange(sel);
  const len = r.end - r.start;
  stSel.textContent =
    len > 1 ? `${len} bytes (0x${hex(r.start)}–0x${hex(r.end - 1)})` : len === 1 ? '1 byte' : 'No selection';
  const ri = regionIndexAt(sel.caret);
  const label = ri >= 0 ? windowRegions[ri].label : hasSpec && windowRegions.length ? 'unparsed' : '';
  if (stField.textContent !== label) {
    stField.textContent = label;
    stField.title = label;
  }
  stField.hidden = !label;
  stNote.textContent = note;
  stNote.hidden = !note;
  const err = parseError ?? '';
  if (stError.textContent !== err) {
    stError.textContent = err ? `⚠ ${err.split('\n')[0]}` : '';
    stError.title = err;
  }
  stError.hidden = !err;
  stSpec.hidden = hasSpec;
}

function flash(text: string) {
  note = text;
  if (noteTimer) clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    note = '';
    updateStatus();
  }, 3000);
  updateStatus();
}

// ---------------------------------------------------------------------------------------------
// Tooltip

function showTooltip(offset: number, clientX: number, clientY: number) {
  const ri = regionIndexAt(offset);
  const b = data[offset];
  tooltip.replaceChildren();
  if (ri >= 0) {
    const reg = windowRegions[ri];
    const t = document.createElement('div');
    t.textContent = reg.label;
    tooltip.appendChild(t);
    const m = document.createElement('div');
    m.className = 'muted';
    m.textContent = `${formatOffset(reg.start)} – ${formatOffset(reg.end - 1)}, ${reg.end - reg.start} bytes`;
    tooltip.appendChild(m);
    if (reg.error) {
      const e = document.createElement('div');
      e.className = 'err';
      e.textContent = 'Parse error in this field';
      tooltip.appendChild(e);
    }
  } else if (hasSpec && windowRegions.length) {
    const t = document.createElement('div');
    t.className = 'muted';
    t.textContent = 'unparsed';
    tooltip.appendChild(t);
  }
  const o = document.createElement('div');
  o.className = ri >= 0 ? '' : 'muted';
  o.textContent = `Offset ${formatOffset(offset)}  ·  0x${hexByte(b)} = ${b}`;
  tooltip.appendChild(o);
  tooltip.hidden = false;
  const rect = view.getBoundingClientRect();
  const tw = tooltip.offsetWidth;
  const th = tooltip.offsetHeight;
  let x = clientX - rect.left + 12;
  let y = clientY - rect.top + 16;
  if (x + tw > rect.width - 4) x = Math.max(4, rect.width - tw - 4);
  if (y + th > rect.height - 4) y = Math.max(4, clientY - rect.top - th - 8);
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}

function hideTooltip() {
  tooltip.hidden = true;
}

// ---------------------------------------------------------------------------------------------
// Selection and messaging

let selectTimer: ReturnType<typeof setTimeout> | undefined;
let selectDirty = false;

function postSelect(now = false) {
  selectDirty = true;
  if (now) {
    flushSelect();
    return;
  }
  selectTimer ??= setTimeout(flushSelect, 60);
}

function flushSelect() {
  if (selectTimer) clearTimeout(selectTimer);
  selectTimer = undefined;
  if (!selectDirty) return;
  selectDirty = false;
  const r = selectionRange(sel);
  post({ type: 'select', start: r.start, end: r.end });
}

/** Bumped on every selection change. */
let selGen = 0;

function setSelection(anchor: number, caret: number, active = true) {
  selGen++;
  const max = Math.max(0, data.byteLength - 1);
  sel = { anchor: clamp(anchor, 0, max), caret: clamp(caret, 0, max), active: active && data.byteLength > 0 };
  saveState();
  schedule();
}

function moveCaret(to: number, extend: boolean) {
  if (!data.byteLength) return;
  if (extend) setSelection(sel.active ? sel.anchor : sel.caret, to);
  else setSelection(to, to);
  revealOffset(sel.caret);
  postSelect();
}

function selectRange(range: Range, reveal: boolean) {
  if (range.end > range.start) setSelection(range.start, range.end - 1);
  else setSelection(range.start, range.start, false);
  if (reveal) revealOffset(range.start, true);
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function saveState() {
  if (!initialised) return;
  saveTimer ??= setTimeout(() => {
    saveTimer = undefined;
    const first = Math.floor(virtual / rowH);
    const state: SavedState = { fileName, topOffset: first * bpr, sel };
    vscode.setState(state);
  }, 150);
}

// ---------------------------------------------------------------------------------------------
// Mouse

interface Hit {
  offset: number;
  area: 'offset' | 'hex' | 'ascii';
  inside: boolean;
}

function hit(clientX: number, clientY: number): Hit {
  const rect = scroller.getBoundingClientRect();
  const x = (clientX - rect.left + scroller.scrollLeft) / cw;
  const y = clientY - rect.top - headerH;
  const { col, area } = hitColumn(cols, x);
  const row = clamp(Math.floor((y + virtual) / rowH), 0, rows - 1);
  const raw = row * bpr + col;
  const size = data.byteLength;
  return { offset: clamp(raw, 0, Math.max(0, size - 1)), area, inside: y >= 0 && raw < size && area !== 'offset' };
}

function onScrollbar(e: MouseEvent) {
  const rect = scroller.getBoundingClientRect();
  return e.clientX - rect.left >= scroller.clientWidth || e.clientY - rect.top >= scroller.clientHeight;
}

let drag: { moved: boolean; toggle: boolean; lastY: number } | undefined;
let autoScroll = 0;

scroller.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || onScrollbar(e) || !data.byteLength) return;
  const rect = scroller.getBoundingClientRect();
  if (e.clientY - rect.top < headerH) return;
  e.preventDefault();
  app.focus();
  const h = hit(e.clientX, e.clientY);
  if (e.shiftKey) {
    setSelection(sel.active ? sel.anchor : sel.caret, h.offset);
    drag = { moved: true, toggle: false, lastY: e.clientY };
  } else {
    const single = sel.active && sel.anchor === h.offset && sel.caret === h.offset;
    setSelection(h.offset, h.offset);
    drag = { moved: false, toggle: single && e.detail === 1, lastY: e.clientY };
  }
  postSelect();
});

window.addEventListener('mousemove', (e) => {
  if (drag) {
    drag.lastY = e.clientY;
    const h = hit(e.clientX, e.clientY);
    if (h.offset !== sel.caret) {
      drag.moved = true;
      setSelection(sel.anchor, h.offset);
      postSelect();
    }
    startAutoScroll();
    return;
  }
  if (e.target !== scroller || onScrollbar(e)) return;
  const h = hit(e.clientX, e.clientY);
  const offset = h.inside ? h.offset : -1;
  if (offset !== hoverOffset) {
    hoverOffset = offset;
    schedule();
  }
  if (offset >= 0) showTooltip(offset, e.clientX, e.clientY);
  else hideTooltip();
});

window.addEventListener('mouseup', () => {
  if (!drag) return;
  if (!drag.moved && drag.toggle) setSelection(sel.caret, sel.caret, false);
  drag = undefined;
  cancelAnimationFrame(autoScroll);
  autoScroll = 0;
  postSelect(true);
});

scroller.addEventListener('mouseleave', () => {
  hoverOffset = -1;
  hideTooltip();
  schedule();
});

function startAutoScroll() {
  if (autoScroll) return;
  const step = () => {
    autoScroll = 0;
    if (!drag) return;
    const rect = scroller.getBoundingClientRect();
    const top = rect.top + headerH;
    const bottom = rect.top + scroller.clientHeight;
    const dy = drag.lastY < top ? drag.lastY - top : drag.lastY > bottom ? drag.lastY - bottom : 0;
    if (!dy) return;
    setVirtual(virtual + clamp(dy, -200, 200) * 0.5);
    const h = hit(rect.left + (hexCellX(cols, sel.caret % bpr) + 1) * cw - scroller.scrollLeft, drag.lastY);
    setSelection(sel.anchor, h.offset);
    postSelect();
    autoScroll = requestAnimationFrame(step);
  };
  autoScroll = requestAnimationFrame(step);
}

scroller.addEventListener('dblclick', (e) => {
  if (onScrollbar(e) || !data.byteLength) return;
  const h = hit(e.clientX, e.clientY);
  const ri = regionIndexAt(h.offset);
  if (ri < 0) return;
  const reg = windowRegions[ri];
  setSelection(reg.start, reg.end - 1);
  postSelect(true);
});

// ---------------------------------------------------------------------------------------------
// Keyboard

app.addEventListener('keydown', (e) => {
  const size = data.byteLength;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key;
  if (mod && (key === 'g' || key === 'G')) {
    e.preventDefault();
    post({ type: 'command', command: 'goToOffset' });
    return;
  }
  if (!size) return;
  const c = sel.caret;
  const page = pageRows() * bpr;
  let to: number | undefined;
  switch (key) {
    case 'ArrowLeft':
      to = c - 1;
      break;
    case 'ArrowRight':
      to = c + 1;
      break;
    case 'ArrowUp':
      to = c - bpr >= 0 ? c - bpr : c;
      break;
    case 'ArrowDown':
      to = c + bpr < size ? c + bpr : c;
      break;
    case 'PageUp':
      setVirtual(virtual - pageRows() * rowH);
      to = Math.max(c % bpr, c - page);
      break;
    case 'PageDown':
      setVirtual(virtual + pageRows() * rowH);
      to = c + page < size ? c + page : c;
      break;
    case 'Home':
      to = mod ? 0 : c - (c % bpr);
      break;
    case 'End':
      to = mod ? size - 1 : Math.min(size - 1, c - (c % bpr) + bpr - 1);
      break;
    case 'Enter':
      e.preventDefault();
      post({ type: 'revealInTree', offset: c });
      return;
    case 'Escape':
      if (sel.active) {
        e.preventDefault();
        setSelection(c, c, false);
        postSelect(true);
      }
      return;
    case 'a':
    case 'A':
      if (!mod) break;
      e.preventDefault();
      setSelection(0, size - 1);
      postSelect(true);
      return;
    case 'n':
    case 'N':
      if (mod || e.altKey) break;
      e.preventDefault();
      queueStep('gap', e.shiftKey ? -1 : 1);
      return;
    case ']':
    case '[':
      if (mod || e.altKey) break;
      e.preventDefault();
      queueStep('field', key === ']' ? 1 : -1);
      return;
  }
  if (to === undefined) return;
  e.preventDefault();
  moveCaret(clamp(to, 0, size - 1), e.shiftKey);
});

let stepQueue: Promise<void> = Promise.resolve();
let queuedSteps = 0;

/** Steps run one after another, so pressing ] three times moves three fields. */
function queueStep(what: 'gap' | 'field', direction: 1 | -1) {
  if (queuedSteps > 8) return;
  queuedSteps++;
  stepQueue = stepQueue.then(() => step(what, direction)).finally(() => queuedSteps--);
}

async function step(what: 'gap' | 'field', direction: 1 | -1) {
  if (!hasSpec) {
    flash('Load a spec to step through fields and unparsed gaps');
    return;
  }
  const from = selectionRange(sel).start;
  const gen = selGen;
  const m = await find(what, direction, from);
  // The user moved on (clicked, typed) while the host searched: drop the stale result.
  if (m.type !== 'found' || gen !== selGen) return;
  if (!m.range) {
    flash(`No ${direction > 0 ? 'next' : 'previous'} ${what === 'gap' ? 'unparsed gap' : 'field'}`);
    return;
  }
  selectRange(m.range, true);
  postSelect(true);
  if (what === 'gap') flash(`Unparsed: ${m.range.end - m.range.start} bytes`);
}

app.addEventListener('focus', () => schedule());
app.addEventListener('blur', () => schedule());

document.addEventListener('copy', (e) => {
  const r = selectionRange(sel);
  if (r.end <= r.start || !e.clipboardData) return;
  const bytes = data.subarray(r.start, Math.min(r.end, r.start + (16 << 20)));
  const text = lastArea === 'ascii' ? Array.from(bytes, asciiChar).join('') : Array.from(bytes, hexByte).join(' ');
  e.clipboardData.setData('text/plain', text);
  e.preventDefault();
});
let lastArea: 'offset' | 'hex' | 'ascii' = 'hex';
scroller.addEventListener('mousedown', (e) => {
  lastArea = hit(e.clientX, e.clientY).area;
});

stPos.addEventListener('click', () => post({ type: 'command', command: 'goToOffset' }));
stSpec.addEventListener('click', () => post({ type: 'command', command: 'loadSpec' }));

// ---------------------------------------------------------------------------------------------
// Messages from the extension host

window.addEventListener('message', (event: MessageEvent<ToHex>) => {
  const m = event.data;
  switch (m.type) {
    case 'init': {
      data = m.data;
      fileName = m.fileName;
      bpr = m.bytesPerRow;
      readMetrics();
      initialised = true;
      const saved = vscode.getState() as SavedState | undefined;
      relayout();
      if (saved && saved.fileName === fileName && saved.sel) {
        sel = saved.sel;
        setSelection(sel.anchor, sel.caret, sel.active);
        setVirtual(Math.floor(saved.topOffset / bpr) * rowH);
        postSelect(true);
      }
      app.focus();
      schedule();
      break;
    }
    case 'data':
      data = m.data;
      setSelection(sel.anchor, sel.caret, sel.active);
      dropRegions();
      relayout();
      break;
    case 'parsed':
      if (m.version !== version) dropRegions();
      version = m.version;
      hasSpec = m.hasSpec;
      parseError = m.error;
      schedule();
      break;
    case 'regions':
    case 'found': {
      const resolve = pending.get(m.requestId);
      pending.delete(m.requestId);
      if (m.type === 'regions' && m.version > version) {
        // A parse finished whose `parsed` message is still in flight: adopt it.
        dropRegions();
        version = m.version;
        schedule();
      }
      resolve?.(m);
      break;
    }
    case 'select':
      selectRange(m, m.reveal);
      break;
    case 'highlight':
      highlight = m.start !== undefined && m.end !== undefined ? { start: m.start, end: m.end } : undefined;
      schedule();
      break;
    case 'config': {
      const top = Math.floor(virtual / rowH) * bpr;
      bpr = m.bytesPerRow;
      dropRegions();
      relayout();
      setVirtual(Math.floor(top / bpr) * rowH);
      break;
    }
  }
});

// Theme changes: VS Code swaps the body class and the CSS variables on <html>.
new MutationObserver(() => {
  theme = readTheme();
  readMetrics();
  relayout();
}).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
new MutationObserver(() => {
  theme = readTheme();
  schedule();
}).observe(document.body, { attributes: true, attributeFilter: ['class'] });

readMetrics();
post({ type: 'ready' });
