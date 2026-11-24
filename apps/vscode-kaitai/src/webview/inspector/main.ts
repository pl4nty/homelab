// Value inspector webview: renders the decode table and posts copy requests.
import type { FromInspector, ToInspector } from '../../shared/protocol.ts';
import { decode, MISSING } from './decode.ts';
import './inspector.css';

type Endian = 'le' | 'be';
/** `override`: the column picked by clicking a header. It wins over the spec's endian until that changes. */
interface State {
  spec?: Endian;
  override?: Endian;
}
declare function acquireVsCodeApi(): {
  postMessage(msg: FromInspector): void;
  getState(): State | undefined;
  setState(s: State): void;
};

const vscode = acquireVsCodeApi();
const root = document.getElementById('root')!;
let state = vscode.getState() ?? {};
let last: Extract<ToInspector, { type: 'bytes' }> | undefined;

function setState(next: State) {
  state = next;
  vscode.setState(next);
}

function cell<K extends 'th' | 'td'>(row: HTMLTableRowElement, tag: K, className: string, text: string) {
  const e = row.appendChild(document.createElement(tag));
  e.className = className;
  e.textContent = text;
  return e;
}

function valueCell(row: HTMLTableRowElement, text: string, label: string, endian?: Endian) {
  const missing = text === MISSING;
  const td = cell(row, 'td', `value ${missing ? 'missing' : 'copy'}`, text);
  td.classList.toggle('active', !!endian && endian === (state.override ?? state.spec));
  if (!endian) td.colSpan = 2;
  if (missing) return;
  td.title = `Copy ${label}`;
  td.tabIndex = 0;
  td.dataset.label = label;
}

function render() {
  if (!last) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Open a file in the Kaitai Hex Editor and place the caret to inspect values.';
    root.replaceChildren(p);
    return;
  }
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  cell(head, 'th', 'label', `@ 0x${last.offset.toString(16).toUpperCase()}`);
  for (const e of ['le', 'be'] as const) {
    const th = cell(head, 'th', e === (state.override ?? state.spec) ? 'col active' : 'col', e.toUpperCase());
    th.title = `${e === 'le' ? 'Little' : 'Big'} endian${e === state.spec ? ' (spec meta/endian)' : ''}. Click to highlight.`;
    th.tabIndex = 0;
    th.dataset.endian = e;
  }
  const body = table.createTBody();
  for (const { label, value, le, be } of decode(last.bytes, last.selectionLength)) {
    const tr = body.insertRow();
    cell(tr, 'th', 'label', label);
    if (value !== undefined) valueCell(tr, value, label);
    else {
      valueCell(tr, le ?? MISSING, `${label} LE`, 'le');
      valueCell(tr, be ?? MISSING, `${label} BE`, 'be');
    }
  }
  root.replaceChildren(table);
}

/** Click or Enter/Space on a value copies it; on a column header it toggles the highlighted byte order. */
function activate(target: HTMLElement) {
  const td = target.closest<HTMLElement>('td.copy');
  if (td) vscode.postMessage({ type: 'copy', text: td.textContent ?? '', label: td.dataset.label ?? '' });
  const endian = target.closest<HTMLElement>('th[data-endian]')?.dataset.endian as Endian | undefined;
  if (endian) {
    setState({ ...state, override: state.override === endian ? undefined : endian });
    render();
  }
}

root.addEventListener('click', (e) => activate(e.target as HTMLElement));
root.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    activate(e.target as HTMLElement);
  }
});

window.addEventListener('message', ({ data }: MessageEvent<ToInspector>) => {
  last = data.type === 'bytes' ? data : undefined;
  if (last && last.endian !== state.spec) setState({ spec: last.endian });
  render();
});

render();
vscode.postMessage({ type: 'ready' });
