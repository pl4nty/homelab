// Browser harness for the hex editor webview: plays the extension host with the real engine.
// Built and driven by scripts/hex-harness.mjs (Playwright). Not part of the extension.
import { compileTemplate } from '../src/engine/kaitai.ts';
import { findDeepestNode, type StructureNode } from '../src/engine/structure.ts';
import type { FromHex, ToHex } from '../src/shared/protocol.ts';
import { findStep, keyedRegionsInRange } from '../src/webview/hex/model.ts';

declare const SPECS: Record<string, string>;
declare const MAIN: string;

const w = window as unknown as Record<string, unknown>;
const toWebview = (m: ToHex) => window.dispatchEvent(new MessageEvent('message', { data: m }));
const log: FromHex[] = [];
w.hostLog = log;
w.toWebview = toWebview;

let roots: StructureNode[] = [];
let data = new Uint8Array(0);
let error: string | undefined;

w.acquireVsCodeApi = () => ({
  getState: () => w.savedState,
  setState: (s: unknown) => {
    w.savedState = s;
  },
  postMessage: (m: FromHex) => {
    log.push(m);
    setTimeout(() => handle(m), 1);
  },
});

function handle(m: FromHex) {
  if (m.type === 'ready') {
    toWebview({ type: 'init', fileName: 'sample.bin', data, bytesPerRow: (w.bpr as number) ?? 16 });
    toWebview({ type: 'parsed', version: 1, hasSpec: !!MAIN, error });
  } else if (m.type === 'requestRegions') {
    const { regions, keys } = keyedRegionsInRange(roots, m.start, m.end);
    toWebview({ type: 'regions', requestId: m.requestId, version: 1, start: m.start, end: m.end, regions, keys });
  } else if (m.type === 'find') {
    const r = findStep(roots, data.byteLength, m.what, m.direction, m.from);
    toWebview({ type: 'found', requestId: m.requestId, range: r && { start: r.start, end: r.end } });
  } else if (m.type === 'revealInTree') {
    const n = findDeepestNode(roots, m.offset);
    if (n?.range) toWebview({ type: 'select', ...n.range, reveal: true });
  }
}

w.boot = async (bytes: number[] | number) => {
  data = typeof bytes === 'number' ? new Uint8Array(bytes).map((_, i) => (i * 7) & 0xff) : new Uint8Array(bytes);
  if (MAIN) {
    const t = await compileTemplate(MAIN, async (name) => SPECS[name.split('/').pop()!]);
    const res = t.parse(data);
    roots = res.roots;
    error = res.error;
  }
  const s = document.createElement('script');
  s.src = 'hex.js';
  document.body.appendChild(s);
};
