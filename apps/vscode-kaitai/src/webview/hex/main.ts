// Kaitai hex editor webview: a virtualised, canvas-drawn hex view with field colouring.
import './hex.css';
import { HUES, TONES } from '../../engine/structure.ts';
import type { FromHex, Region, ToHex } from '../../shared/protocol.ts';
import {
  asciiCellX,
  asciiChar,
  assignColours,
  clamp,
  columns,
  formatOffset,
  hex,
  hexByte,
  hexCellX,
  hitColumn,
  isPrintable,
  mergeRegions,
  nativeToVirtual,
  offsetDigits,
  type Range,
  regionAt,
  rowContour,
  rowCount,
  type Selection,
  scrollModel,
  scrollToRow,
  selectionRange,
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

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement, text = '') {
  const e = document.createElement(tag);
  e.className = cls;
  e.textContent = text;
  return parent.appendChild(e);
}

const app = document.getElementById('app')!;
const view = el('div', 'view', app);
const scroller = el('div', 'scroller', view);
const spacer = el('div', 'spacer', scroller);
const canvas = el('canvas', 'grid', view);
const ctx = canvas.getContext('2d', { alpha: false })!;
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
const stSpec = el('button', 'spec', status, 'Load Spec…');
stSpec.title = 'Choose a .ksy spec to parse this file with';

// ---------------------------------------------------------------------------------------------
// State

let data: Uint8Array = new Uint8Array(0);
let fileName = '';
let bpr = 16;
let cols = columns(0, bpr);
let rows = 1;
let sel: Selection = { anchor: 0, caret: 0, active: false };
/** Bumped on every selection change, so a slow stepper reply can tell that the user moved on. */
let selGen = 0;
/** Scroll position in virtual pixels (row * rowH), which the native scrollTop only approximates. */
let virtual = 0;
let lastNative = -1;
let model = scrollModel(1, 20, 100);
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

// Region cache: block index -> regions overlapping [i*BLOCK, (i+1)*BLOCK).
const blocks = new Map<number, Region[]>();
const pendingBlocks = new Set<number>();
/** Regions of the blocks around the visible rows, with the palette index of each. */
let windowRegions: Region[] = [];
let windowColours: number[] = [];
let windowKey = '';

// ---------------------------------------------------------------------------------------------
// Theme and metrics

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
  boundaryAlpha: number;
  palette: string[];
}

function cssVar(name: string, fallback = '') {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function readTheme(): Theme {
  const kind = document.body.classList;
  const hc = kind.contains('vscode-high-contrast') || kind.contains('vscode-high-contrast-light');
  const light = kind.contains('vscode-light') || kind.contains('vscode-high-contrast-light');
  const fg = cssVar('--vscode-editor-foreground', light ? '#333' : '#ccc');
  const alphas = hc ? [0.34, 0.52, 0.7] : light ? [0.15, 0.3, 0.45] : [0.2, 0.36, 0.52];
  // Indexed by colour key: hue * TONES + tone.
  const palette = Array.from({ length: HUES * TONES }, (_, key) => {
    const hue = HUE_DEGREES[Math.floor(key / TONES)];
    return `hsla(${hue}, 70%, ${light ? 48 : 58}%, ${alphas[key % TONES]})`;
  });
  const focus = cssVar('--vscode-focusBorder', '#0078d4');
  return {
    bg: cssVar('--vscode-editor-background', light ? '#fff' : '#1e1e1e'),
    fg,
    muted: cssVar('--vscode-editorLineNumber-foreground', cssVar('--vscode-descriptionForeground', '#858585')),
    activeLine: cssVar('--vscode-editorLineNumber-activeForeground', fg),
    border: cssVar('--vscode-editorGroup-border', cssVar('--vscode-panel-border', 'rgba(128,128,128,0.35)')),
    selBg: cssVar('--vscode-editor-selectionBackground', '#264f78'),
    selFg: cssVar('--vscode-editor-selectionForeground', fg),
    inactiveSelBg: cssVar('--vscode-editor-inactiveSelectionBackground', 'rgba(128,128,128,0.35)'),
    caret: cssVar('--vscode-editorCursor-foreground', fg),
    error: cssVar('--vscode-editorError-foreground', '#f14c4c'),
    highlight: cssVar('--vscode-editor-findMatchHighlightBorder', focus),
    highlightBg: cssVar('--vscode-editor-findMatchHighlightBackground', 'rgba(234,92,0,0.33)'),
    hover: cssVar('--vscode-editorHoverWidget-border', focus),
    boundaryAlpha: hc ? 0.9 : 0.35,
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

let theme = readTheme();
readMetrics();

// ---------------------------------------------------------------------------------------------
// Layout and scrolling

function relayout() {
  cols = columns(data.byteLength, bpr);
  rows = rowCount(data.byteLength, bpr);
  const w = scroller.clientWidth;
  const h = scroller.clientHeight;
  model = scrollModel(rows, rowH, Math.max(0, h - headerH));
  spacer.style.height = `${model.spacer + headerH}px`;
  spacer.style.width = `${Math.ceil((cols.width + 1) * cw)}px`;
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

/** Offset of the first byte of the top row. */
function topOffset() {
  return Math.floor(virtual / rowH) * bpr;
}

function pageRows() {
  return Math.max(1, Math.floor(model.view / rowH) - 1);
}

function revealOffset(offset: number, center = false) {
  const row = Math.floor(offset / bpr);
  const vis = visibleRows(virtual, rowH, model.view, rows);
  const far = row < vis.first || row > vis.first + vis.count;
  setVirtual(scrollToRow(virtual, row, rowH, model.view, center && far));
}

scroller.addEventListener('scroll', () => {
  const t = scroller.scrollTop;
  // Our own scrollTop writes come back as scroll events; keep the precise virtual offset then.
  if (Math.abs(t - lastNative) >= 1) {
    virtual = nativeToVirtual(model, t);
    lastNative = t;
    saveState();
  }
  hover(-1);
  schedule();
});

scroller.addEventListener(
  'wheel',
  (e) => {
    if (!model.scaled || e.ctrlKey) return;
    // In scaled mode one native pixel spans many rows; scroll by real pixels instead.
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * rowH : e.deltaMode === 2 ? e.deltaY * model.view : e.deltaY;
    scroller.scrollLeft += e.deltaMode === 1 ? e.deltaX * cw : e.deltaX;
    setVirtual(virtual + dy);
  },
  { passive: false },
);

new ResizeObserver(relayout).observe(view);

// VS Code swaps the body class and the CSS variables on <html> when the theme or font changes.
const themeObserver = new MutationObserver(() => {
  theme = readTheme();
  readMetrics();
  relayout();
});
themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

// ---------------------------------------------------------------------------------------------
// Regions

function dropRegions() {
  blocks.clear();
  pendingBlocks.clear();
  windowKey = '';
  windowRegions = [];
  windowColours = [];
}

/** Requests the regions of the bytes in [start, end) plus a block either side, and merges what has arrived. */
function loadRegions(start: number, end: number) {
  if (!hasSpec || end <= start) return;
  const b0 = Math.max(0, Math.floor(start / BLOCK) - 1);
  const b1 = Math.min(Math.floor((data.byteLength - 1) / BLOCK), Math.floor((end - 1) / BLOCK) + 1);
  const loaded: Region[][] = [];
  for (let b = b0; b <= b1; b++) {
    const regions = blocks.get(b);
    if (regions) loaded.push(regions);
    else if (!pendingBlocks.has(b)) {
      pendingBlocks.add(b);
      post({ type: 'requestRegions', start: b * BLOCK, end: Math.min(data.byteLength, (b + 1) * BLOCK) });
    }
  }
  const key = `${b0}:${b1}`;
  if (key === windowKey) return;
  windowKey = key;
  windowRegions = mergeRegions(loaded);
  windowColours = assignColours(windowRegions);
}

function storeRegions(m: Extract<ToHex, { type: 'regions' }>) {
  if (m.version < version) return; // from before the last parse; the block was requested again
  if (m.version > version) {
    // A parse finished whose `parsed` message is still in flight: adopt it.
    dropRegions();
    version = m.version;
  }
  const block = m.start / BLOCK;
  pendingBlocks.delete(block);
  blocks.set(block, m.regions);
  windowKey = '';
  // Keep the blocks nearest to the view.
  const near = Math.floor(topOffset() / BLOCK);
  const far = [...blocks.keys()].sort((a, b) => Math.abs(b - near) - Math.abs(a - near));
  for (const b of far.slice(0, Math.max(0, blocks.size - MAX_BLOCKS))) blocks.delete(b);
  schedule();
}

// ---------------------------------------------------------------------------------------------
// Rendering

let frame = 0;
function schedule() {
  if (!frame) frame = requestAnimationFrame(render);
}

/** Scroll position and visible rows of the frame being drawn. */
let sx = 0;
let vis = visibleRows(0, rowH, 0, 1);

const rowY = (row: number) => headerH + vis.y0 + (row - vis.first) * rowH;
const hexX = (col: number) => (hexCellX(cols, col) - 0.5) * cw - sx;
const asciiX = (col: number) => asciiCellX(cols, col) * cw - sx;

/** Pixel spans [left, right] of byte columns a..b in the hex and the ASCII area. */
function spans(a: number, b: number) {
  return [
    [hexX(a), hexX(b) + 3 * cw],
    [asciiX(a), asciiX(b) + cw],
  ].map(([x0, x1]) => [Math.round(x0), Math.round(x1)]);
}

function render() {
  frame = 0;
  if (!initialised) return;
  const W = scroller.clientWidth;
  const H = scroller.clientHeight;
  const size = data.byteLength;
  sx = scroller.scrollLeft;
  vis = visibleRows(virtual, rowH, model.view, rows);
  const vs = vis.first * bpr;
  const ve = Math.min(size, (vis.first + vis.count) * bpr);
  loadRegions(vs, ve);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.font = font;
  ctx.textBaseline = 'middle';

  // Region index of each visible byte; later (narrower) regions overwrite wider ones.
  const cell = new Int32Array(Math.max(0, ve - vs)).fill(-1);
  windowRegions.forEach((r, i) => {
    if (r.end > vs && r.start < ve) cell.fill(i, Math.max(r.start, vs) - vs, Math.min(r.end, ve) - vs);
  });
  const range = selectionRange(sel);
  const focused = document.hasFocus() && document.activeElement === app;
  const selBg = focused ? theme.selBg : theme.inactiveSelBg;
  const digits = offsetDigits(size);
  const caretRow = Math.floor(sel.caret / bpr);
  const caretCol = sel.caret % bpr;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, headerH, W, H - headerH);
  ctx.clip();
  for (let row = vis.first; row < vis.first + vis.count; row++) {
    const y = rowY(row);
    const mid = y + rowH / 2;
    const rowStart = row * bpr;
    const n = Math.min(bpr, size - rowStart);
    ctx.fillStyle = row === caretRow ? theme.activeLine : theme.muted;
    ctx.fillText(hex(rowStart, digits), cw * 0.5 - sx, mid);
    for (let c = 0; c < n; c++) {
      const off = rowStart + c;
      const ri = cell[off - vs];
      const hx = hexX(c);
      const ax = asciiX(c);
      // A hex cell is 3 chars wide; the group gap after it is filled when the next byte matches.
      const hexW = (joined: boolean) => (c % 8 === 7 && c + 1 < n && joined ? 4 : 3) * cw;
      if (ri >= 0) {
        const w = hexW(cell[off + 1 - vs] === ri);
        ctx.fillStyle = theme.palette[windowColours[ri]];
        ctx.fillRect(hx, y, w, rowH);
        ctx.fillRect(ax, y, cw, rowH);
        if (windowRegions[ri].start === off && c > 0 && cell[off - 1 - vs] >= 0) {
          // Boundary between two adjacent fields.
          ctx.globalAlpha = theme.boundaryAlpha;
          ctx.fillStyle = theme.fg;
          ctx.fillRect(Math.round(hx), y + 2, 1, rowH - 4);
          ctx.fillRect(Math.round(ax), y + 2, 1, rowH - 4);
          ctx.globalAlpha = 1;
        }
        if (windowRegions[ri].error) {
          ctx.fillStyle = theme.error;
          ctx.fillRect(hx, y + rowH - 2, w, 2);
          ctx.fillRect(ax, y + rowH - 2, cw, 2);
        }
      }
      const selected = off >= range.start && off < range.end;
      if (selected) {
        ctx.fillStyle = selBg;
        ctx.fillRect(hx, y, hexW(off + 1 < range.end), rowH);
        ctx.fillRect(ax, y, cw, rowH);
      }
      const b = data[off];
      ctx.fillStyle = selected ? theme.selFg : theme.fg;
      if (b === 0 && !selected) ctx.globalAlpha = 0.5;
      ctx.fillText(hexByte(b), hx + 0.5 * cw, mid);
      if (!isPrintable(b)) ctx.globalAlpha = selected ? 0.6 : 0.4;
      ctx.fillText(asciiChar(b), ax, mid);
      ctx.globalAlpha = 1;
    }
  }

  // Outlines: hovered field, highlight from the tree, caret.
  const hovered = hoverOffset >= 0 && regionAt(windowRegions, hoverOffset);
  if (hovered) outline(hovered, theme.hover, 1);
  if (highlight) outline(highlight, theme.highlight, 2, theme.highlightBg);
  if (size > 0 && caretRow >= vis.first && caretRow < vis.first + vis.count) {
    ctx.strokeStyle = focused ? theme.caret : theme.muted;
    ctx.lineWidth = 1;
    for (const [x0, x1] of spans(caretCol, caretCol)) {
      ctx.strokeRect(x0 + 0.5, rowY(caretRow) + 0.5, x1 - x0 - 1, rowH - 1);
    }
  }
  ctx.restore();

  // Header with column offsets.
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, W, headerH);
  for (let c = 0; c < bpr; c++) {
    ctx.fillStyle = c === caretCol ? theme.activeLine : theme.muted;
    ctx.fillText(hexByte(c), hexX(c) + 0.5 * cw, headerH / 2);
    ctx.fillText(hex(c % 16), asciiX(c), headerH / 2);
  }
  ctx.fillStyle = theme.border;
  ctx.fillRect(0, headerH - 1, W, 1);
  ctx.fillRect(Math.round((cols.hexStart - 1) * cw - sx), 0, 1, H);
  ctx.fillRect(Math.round((cols.asciiStart - 1) * cw - sx), 0, 1, H);

  updateStatus();
}

/** Draws the contour of a byte range in both areas, over an optional translucent fill. */
function outline(range: Range, colour: string, width: number, fill?: string) {
  const r = { start: range.start, end: Math.min(range.end, data.byteLength) };
  for (let row = vis.first; row < vis.first + vis.count; row++) {
    const k = rowContour(r, bpr, row);
    if (!k) continue;
    const y = Math.round(rowY(row));
    for (const [x0, x1] of spans(k.a, k.b)) {
      if (fill) {
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = fill;
        ctx.fillRect(x0, y, x1 - x0, rowH);
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = colour;
      ctx.fillRect(x0, y, width, rowH);
      ctx.fillRect(x1 - width, y, width, rowH);
    }
    if (k.top) for (const [x0, x1] of spans(...k.top)) ctx.fillRect(x0, y, x1 - x0, width);
    if (k.bottom) for (const [x0, x1] of spans(...k.bottom)) ctx.fillRect(x0, y + rowH - width, x1 - x0, width);
  }
}

// ---------------------------------------------------------------------------------------------
// Status bar and tooltip

/** Label of the field at `offset`: `unparsed` where a parsed file has none, nothing without a parse. */
function fieldLabel(offset: number) {
  return regionAt(windowRegions, offset)?.label ?? (hasSpec && windowRegions.length ? 'unparsed' : '');
}

/** Sets the text of a status item (only when it changed) and hides the item while it is empty. */
function setStatus(item: HTMLElement, text: string, title?: string) {
  if (item.textContent !== text) item.textContent = text;
  if (title !== undefined && item.title !== title) item.title = title;
  item.hidden = !text;
}

function updateStatus() {
  const { start, end } = selectionRange(sel);
  const len = end - start;
  setStatus(stPos, data.byteLength ? `Offset ${formatOffset(sel.caret)}` : 'Empty file');
  setStatus(
    stSel,
    len > 1 ? `${len} bytes (0x${hex(start)}–0x${hex(end - 1)})` : len === 1 ? '1 byte' : 'No selection',
  );
  const label = fieldLabel(sel.caret);
  setStatus(stField, label, label);
  setStatus(stNote, note);
  setStatus(stError, parseError ? `⚠ ${parseError.split('\n')[0]}` : '', parseError ?? '');
  stSpec.hidden = hasSpec;
}

function flash(text: string) {
  note = text;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    note = '';
    updateStatus();
  }, 3000);
  updateStatus();
}

/** Sets the hovered byte (-1: none) and shows its tooltip at the pointer. */
function hover(offset: number, clientX = 0, clientY = 0) {
  if (offset !== hoverOffset) {
    hoverOffset = offset;
    schedule();
  }
  tooltip.hidden = offset < 0;
  if (offset < 0) return;
  const reg = regionAt(windowRegions, offset);
  const b = data[offset];
  tooltip.replaceChildren();
  if (reg) {
    el('div', '', tooltip, reg.label);
    const bytes = `${formatOffset(reg.start)} – ${formatOffset(reg.end - 1)}, ${reg.end - reg.start} bytes`;
    el('div', 'muted', tooltip, bytes);
    if (reg.error) el('div', 'err', tooltip, 'Parse error in this field');
  } else if (fieldLabel(offset)) {
    el('div', 'muted', tooltip, fieldLabel(offset));
  }
  el('div', reg ? '' : 'muted', tooltip, `Offset ${formatOffset(offset)}  ·  0x${hexByte(b)} = ${b}`);
  // Below and right of the pointer, kept inside the view.
  const rect = view.getBoundingClientRect();
  let x = clientX - rect.left + 12;
  let y = clientY - rect.top + 16;
  if (x + tooltip.offsetWidth > rect.width - 4) x = Math.max(4, rect.width - tooltip.offsetWidth - 4);
  if (y + tooltip.offsetHeight > rect.height - 4) y = Math.max(4, y - tooltip.offsetHeight - 24);
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}

// ---------------------------------------------------------------------------------------------
// Selection and persistence

function setSelection(anchor: number, caret: number, active = true) {
  selGen++;
  const max = Math.max(0, data.byteLength - 1);
  sel = { anchor: clamp(anchor, 0, max), caret: clamp(caret, 0, max), active: active && data.byteLength > 0 };
  saveState();
  schedule();
}

function selectRange(range: Range, reveal: boolean) {
  if (range.end > range.start) setSelection(range.start, range.end - 1);
  else setSelection(range.start, range.start, false);
  if (reveal) revealOffset(range.start, true);
}

let selectTimer: ReturnType<typeof setTimeout> | undefined;

/** Tells the host about the selection: at once, or throttled while dragging and key-repeating. */
function postSelect(now = false) {
  if (!now) {
    selectTimer ??= setTimeout(postSelect, 60, true);
    return;
  }
  clearTimeout(selectTimer);
  selectTimer = undefined;
  post({ type: 'select', ...selectionRange(sel) });
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function saveState() {
  if (!initialised || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    vscode.setState({ fileName, topOffset: topOffset(), sel } satisfies SavedState);
  }, 150);
}

// ---------------------------------------------------------------------------------------------
// Mouse

type Area = 'offset' | 'hex' | 'ascii';

/** The byte under the pointer (clamped to the file), and whether the pointer is really on one. */
function hit(e: { clientX: number; clientY: number }): { offset: number; area: Area; inside: boolean } {
  const rect = scroller.getBoundingClientRect();
  const y = e.clientY - rect.top - headerH;
  const { col, area } = hitColumn(cols, (e.clientX - rect.left + scroller.scrollLeft) / cw);
  const raw = clamp(Math.floor((y + virtual) / rowH), 0, rows - 1) * bpr + col;
  const size = data.byteLength;
  return { offset: clamp(raw, 0, Math.max(0, size - 1)), area, inside: y >= 0 && raw < size && area !== 'offset' };
}

function onScrollbar(e: MouseEvent) {
  const rect = scroller.getBoundingClientRect();
  return e.clientX - rect.left >= scroller.clientWidth || e.clientY - rect.top >= scroller.clientHeight;
}

/** Set while the mouse button is down. `toggle`: a click without movement clears the selection. */
let drag: { toggle: boolean; x: number; y: number } | undefined;
let autoScroll = 0;
/** Where the last click went; decides whether copy gives hex or text. */
let lastArea: Area = 'hex';

scroller.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || onScrollbar(e) || !data.byteLength) return;
  if (e.clientY - scroller.getBoundingClientRect().top < headerH) return;
  e.preventDefault();
  app.focus();
  const { offset, area } = hit(e);
  lastArea = area;
  // Clicking the only selected byte again deselects it (unless it starts a double-click or a drag).
  const toggle = !e.shiftKey && e.detail === 1 && sel.active && sel.anchor === offset && sel.caret === offset;
  setSelection(e.shiftKey ? anchor() : offset, offset);
  drag = { toggle, x: e.clientX, y: e.clientY };
  postSelect();
});

window.addEventListener('mousemove', (e) => {
  if (drag) {
    drag.x = e.clientX;
    drag.y = e.clientY;
    dragTo(hit(e).offset);
    if (!autoScroll) autoScrollStep();
    return;
  }
  const h = e.target === scroller && !onScrollbar(e) ? hit(e) : undefined;
  hover(h?.inside ? h.offset : -1, e.clientX, e.clientY);
});

window.addEventListener('mouseup', () => {
  if (!drag) return;
  if (drag.toggle) setSelection(sel.caret, sel.caret, false);
  drag = undefined;
  postSelect(true);
});

scroller.addEventListener('mouseleave', () => hover(-1));

scroller.addEventListener('dblclick', (e) => {
  if (onScrollbar(e) || !data.byteLength) return;
  const reg = regionAt(windowRegions, hit(e).offset);
  if (!reg) return;
  setSelection(reg.start, reg.end - 1);
  postSelect(true);
});

/** Start of a shift-extended selection. */
function anchor() {
  return sel.active ? sel.anchor : sel.caret;
}

function dragTo(offset: number) {
  if (!drag || offset === sel.caret) return;
  drag.toggle = false;
  setSelection(sel.anchor, offset);
  postSelect();
}

/** While dragging with the pointer above or below the rows, scrolls and extends the selection. */
function autoScrollStep() {
  autoScroll = 0;
  if (!drag) return;
  const rect = scroller.getBoundingClientRect();
  const top = rect.top + headerH;
  const bottom = rect.top + scroller.clientHeight;
  const dy = drag.y < top ? drag.y - top : drag.y > bottom ? drag.y - bottom : 0;
  if (!dy) return;
  setVirtual(virtual + clamp(dy, -200, 200) * 0.5);
  dragTo(hit({ clientX: drag.x, clientY: drag.y }).offset);
  autoScroll = requestAnimationFrame(autoScrollStep);
}

// ---------------------------------------------------------------------------------------------
// Keyboard and steppers

app.addEventListener('keydown', (e) => {
  const size = data.byteLength;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const c = sel.caret;
  const rowStart = c - (c % bpr);
  const page = pageRows();
  let to: number | undefined;
  if (mod && key === 'g') post({ type: 'command', command: 'goToOffset' });
  else if (!size) return;
  else if (mod && key === 'a') {
    setSelection(0, size - 1);
    postSelect(true);
  } else if (key === 'Enter') post({ type: 'revealInTree', offset: c });
  else if (key === 'Escape' && sel.active) {
    setSelection(c, c, false);
    postSelect(true);
  } else if (key === 'n' && !mod && !e.altKey) queueStep('gap', e.shiftKey ? -1 : 1);
  else if ((key === ']' || key === '[') && !mod && !e.altKey) queueStep('field', key === ']' ? 1 : -1);
  else if (key === 'ArrowLeft') to = c - 1;
  else if (key === 'ArrowRight') to = c + 1;
  else if (key === 'ArrowUp') to = c - bpr >= 0 ? c - bpr : c;
  else if (key === 'ArrowDown') to = c + bpr < size ? c + bpr : c;
  else if (key === 'Home') to = mod ? 0 : rowStart;
  else if (key === 'End') to = mod ? size - 1 : rowStart + bpr - 1;
  else if (key === 'PageUp') {
    setVirtual(virtual - page * rowH);
    to = Math.max(c % bpr, c - page * bpr);
  } else if (key === 'PageDown') {
    setVirtual(virtual + page * rowH);
    to = c + page * bpr < size ? c + page * bpr : c;
  } else return;
  e.preventDefault();
  if (to === undefined) return;
  setSelection(e.shiftKey ? anchor() : to, to);
  revealOffset(sel.caret);
  postSelect();
});

app.addEventListener('focus', schedule);
app.addEventListener('blur', schedule);

document.addEventListener('copy', (e) => {
  const r = selectionRange(sel);
  if (r.end <= r.start || !e.clipboardData) return;
  const bytes = data.subarray(r.start, Math.min(r.end, r.start + (16 << 20)));
  const text = lastArea === 'ascii' ? Array.from(bytes, asciiChar).join('') : Array.from(bytes, hexByte).join(' ');
  e.clipboardData.setData('text/plain', text);
  e.preventDefault();
});

stPos.addEventListener('click', () => post({ type: 'command', command: 'goToOffset' }));
stSpec.addEventListener('click', () => post({ type: 'command', command: 'loadSpec' }));

let stepQueue = Promise.resolve();
let queuedSteps = 0;
let onFound: ((range: Range | undefined) => void) | undefined;

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
  const gen = selGen;
  const found = new Promise<Range | undefined>((resolve) => {
    onFound = resolve;
  });
  post({ type: 'find', what, direction, from: selectionRange(sel).start });
  const range = await found;
  // The user moved on (clicked, typed) while the host searched: drop the stale result.
  if (gen !== selGen) return;
  if (!range) {
    flash(`No ${direction > 0 ? 'next' : 'previous'} ${what === 'gap' ? 'unparsed gap' : 'field'}`);
    return;
  }
  selectRange(range, true);
  postSelect(true);
  if (what === 'gap') flash(`Unparsed: ${range.end - range.start} bytes`);
}

// ---------------------------------------------------------------------------------------------
// Messages from the extension host

window.addEventListener('message', ({ data: m }: MessageEvent<ToHex>) => {
  switch (m.type) {
    case 'init': {
      data = m.data;
      fileName = m.fileName;
      bpr = m.bytesPerRow;
      initialised = true;
      relayout();
      const saved = vscode.getState() as SavedState | undefined;
      if (saved?.sel && saved.fileName === fileName) {
        setSelection(saved.sel.anchor, saved.sel.caret, saved.sel.active);
        setVirtual(Math.floor(saved.topOffset / bpr) * rowH);
        postSelect(true);
      }
      app.focus();
      break;
    }
    case 'data':
      data = m.data;
      dropRegions();
      relayout();
      setSelection(sel.anchor, sel.caret, sel.active);
      break;
    case 'parsed':
      if (m.version !== version) dropRegions();
      version = m.version;
      hasSpec = m.hasSpec;
      parseError = m.error;
      schedule();
      break;
    case 'regions':
      storeRegions(m);
      break;
    case 'found':
      onFound?.(m.range);
      break;
    case 'select':
      selectRange(m, m.reveal);
      break;
    case 'highlight':
      highlight = m.start === undefined || m.end === undefined ? undefined : { start: m.start, end: m.end };
      schedule();
      break;
    case 'config': {
      const top = topOffset();
      bpr = m.bytesPerRow;
      relayout();
      setVirtual(Math.floor(top / bpr) * rowH);
      break;
    }
  }
});

post({ type: 'ready' });
