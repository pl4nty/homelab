// Value inspector webview: renders the decode table and posts copy requests.
import type { FromInspector, ToInspector } from '../../shared/protocol.ts';
import { decode, MISSING, type Row } from './decode.ts';
import './inspector.css';

interface VsCodeApi {
  postMessage(msg: FromInspector): void;
  getState(): { endian?: 'le' | 'be' } | undefined;
  setState(s: { endian?: 'le' | 'be' }): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const root = document.getElementById('root')!;
let last: Extract<ToInspector, { type: 'bytes' }> | undefined;
/** Column picked by clicking a header; overrides the spec's endian until the spec's endian changes. */
let override = vscode.getState()?.endian;
let specEndian: 'le' | 'be' | undefined;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function valueCell(text: string, label: string, cls: string, colspan = 1) {
  const td = el('td', cls, text);
  if (colspan > 1) td.colSpan = colspan;
  if (text !== MISSING) {
    td.classList.add('copy');
    td.title = `Copy ${label}`;
    td.tabIndex = 0;
    td.dataset.copy = text;
    td.dataset.label = label;
  } else td.classList.add('missing');
  return td;
}

function render() {
  root.replaceChildren();
  if (!last) {
    root.append(el('p', 'empty', 'Open a file in the Kaitai Hex Editor and place the caret to inspect values.'));
    return;
  }
  const endian = override ?? specEndian;
  const table = el('table');
  const head = el('tr');
  head.append(el('th', 'label', `@ 0x${last.offset.toString(16).toUpperCase()}`));
  for (const e of ['le', 'be'] as const) {
    const th = el('th', `col ${e === endian ? 'active' : ''}`, e.toUpperCase());
    th.title = `${e === 'le' ? 'Little' : 'Big'} endian${e === specEndian ? ' (spec meta/endian)' : ''}. Click to highlight.`;
    th.dataset.endian = e;
    head.append(th);
  }
  table.append(el('thead'));
  table.tHead!.append(head);
  const body = el('tbody');
  for (const row of decode(last.bytes, last.selectionLength) as Row[]) {
    const tr = el('tr', row.text ? 'text' : '');
    tr.append(el('th', 'label', row.label));
    if (row.value !== undefined) tr.append(valueCell(row.value, row.label, 'value', 2));
    else {
      tr.append(valueCell(row.le!, `${row.label} LE`, `value ${endian === 'le' ? 'active' : ''}`));
      tr.append(valueCell(row.be!, `${row.label} BE`, `value ${endian === 'be' ? 'active' : ''}`));
    }
    body.append(tr);
  }
  table.append(body);
  root.append(table);
}

function copy(target: HTMLElement) {
  const td = target.closest<HTMLElement>('td.copy');
  if (td?.dataset.copy !== undefined)
    vscode.postMessage({ type: 'copy', text: td.dataset.copy, label: td.dataset.label ?? '' });
  const th = target.closest<HTMLElement>('th[data-endian]');
  if (th) {
    const e = th.dataset.endian as 'le' | 'be';
    override = override === e ? undefined : e;
    vscode.setState({ endian: override });
    vscode.postMessage({ type: 'setEndian', endian: e });
    render();
  }
}

root.addEventListener('click', (e) => copy(e.target as HTMLElement));
root.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    copy(e.target as HTMLElement);
  }
});

window.addEventListener('message', (e: MessageEvent<ToInspector>) => {
  const msg = e.data;
  if (msg.type === 'bytes') {
    if (msg.endian !== specEndian) {
      specEndian = msg.endian;
      override = undefined;
      vscode.setState({});
    }
    last = msg;
  } else if (msg.type === 'empty') last = undefined;
  render();
});

render();
vscode.postMessage({ type: 'ready' });
