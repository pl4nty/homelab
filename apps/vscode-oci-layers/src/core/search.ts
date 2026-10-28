// File and text search over an Overlay. Backs the proposed FileSearchProvider2 /
// TextSearchProvider2 APIs and the stable "Find in Image" fallback commands.

import type { FsNode, Overlay } from './overlay.ts';
import { join } from './overlay.ts';

/** Depth-first walk of regular files under `root`, without following symlinks. */
export function* walkFiles(o: Overlay, root = ''): Generator<[string, FsNode]> {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: [string, FsNode][];
    try {
      entries = o.readdir(dir);
    } catch {
      continue;
    }
    entries.sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0)); // reversed: popped in order
    for (const [name, node] of entries) {
      const p = join(dir, name);
      if (node.type === 'dir') stack.push(p);
      else if (node.type === 'file') yield [p, node];
    }
  }
}

/** Translate a VS Code glob (**, *, ?, {a,b}, [abc]) to a RegExp over "/"-separated paths. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let inBraces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') { inBraces++; re += '(?:'; }
    else if (c === '}' && inBraces) { inBraces--; re += ')'; }
    else if (c === ',' && inBraces) re += '|';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) re += '\\[';
      else { re += '[' + glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'; i = end; }
    } else re += c.replace(/[.+^$()|\\/]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export interface PathFilter { includes?: string[]; excludes?: string[] }

/** VS Code semantics: a glob also matches everything below a matching folder. */
export function pathFilter({ includes = [], excludes = [] }: PathFilter): (p: string) => boolean {
  const inc = includes.map(globToRegExp);
  const exc = excludes.map(globToRegExp);
  const matches = (res: RegExp[], p: string) => {
    for (let q = p; q; q = q.includes('/') ? q.slice(0, q.lastIndexOf('/')) : '') if (res.some((r) => r.test(q))) return true;
    return false;
  };
  return (p) => (!inc.length || matches(inc, p)) && !matches(exc, p);
}

/** Case-insensitive subsequence match, as Quick Open does before its own scoring. */
export function fuzzyMatch(pattern: string, path: string): boolean {
  const pat = pattern.replace(/\s+/g, '').toLowerCase();
  const s = path.toLowerCase();
  let j = 0;
  for (let i = 0; i < s.length && j < pat.length; i++) if (s[i] === pat[j]) j++;
  return j === pat.length;
}

export function findFiles(o: Overlay, pattern: string, opts: PathFilter & { maxResults?: number; isCancelled?: () => boolean } = {}): string[] {
  const keep = pathFilter(opts);
  const out: string[] = [];
  for (const [p] of walkFiles(o)) {
    if (opts.isCancelled?.()) break;
    if (keep(p) && (!pattern || fuzzyMatch(pattern, p))) {
      out.push(p);
      if (opts.maxResults && out.length >= opts.maxResults) break;
    }
  }
  return out;
}

export interface TextQuery { pattern: string; isRegExp?: boolean; isCaseSensitive?: boolean; isWordMatch?: boolean; isMultiline?: boolean }

export interface TextMatch {
  path: string;
  /** Zero-based, UTF-16 offsets as VS Code ranges expect. */
  start: { line: number; character: number };
  end: { line: number; character: number };
  /** Text of the lines the match spans. */
  preview: string;
  /** Match range relative to `preview` (line 0 = first preview line). */
  previewStart: { line: number; character: number };
  previewEnd: { line: number; character: number };
}

export function queryRegExp(q: TextQuery): RegExp {
  let src = q.isRegExp ? q.pattern : q.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (q.isWordMatch) src = `\\b${src}\\b`;
  return new RegExp(src, `g${q.isCaseSensitive ? '' : 'i'}${q.isMultiline ? 'm' : ''}u`);
}

const decoder = new TextDecoder('utf-8', { fatal: false });

/** Heuristic used by grep/ripgrep: a NUL byte in the first 8 KiB means binary. */
export function isBinary(data: Uint8Array): boolean {
  return data.subarray(0, 8192).includes(0);
}

export function searchText(
  o: Overlay,
  query: TextQuery,
  opts: PathFilter & { maxResults?: number; maxFileSize?: number; isCancelled?: () => boolean; onMatch?: (m: TextMatch) => void } = {},
): { matches: number; limitHit: boolean } {
  const keep = pathFilter(opts);
  const re = queryRegExp(query);
  let matches = 0;
  for (const [p, node] of walkFiles(o)) {
    if (opts.isCancelled?.()) break;
    const data = node.data ?? new Uint8Array();
    if (!keep(p) || (opts.maxFileSize && data.length > opts.maxFileSize) || isBinary(data)) continue;
    const text = decoder.decode(data);
    const lineStarts = [0];
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1);
    const pos = (off: number) => {
      let lo = 0, hi = lineStarts.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= off) lo = mid; else hi = mid - 1; }
      return { line: lo, character: off - lineStarts[lo] };
    };
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m[0] === '') { re.lastIndex++; continue; }
      if (opts.maxResults && matches >= opts.maxResults) return { matches, limitHit: true };
      const start = pos(m.index);
      const end = pos(m.index + m[0].length);
      const lineEnd = end.line + 1 < lineStarts.length ? lineStarts[end.line + 1] - 1 : text.length;
      const preview = text.slice(lineStarts[start.line], lineEnd).replace(/\r$/, '');
      opts.onMatch?.({
        path: p, start, end, preview,
        previewStart: { line: 0, character: start.character },
        previewEnd: { line: end.line - start.line, character: end.character },
      });
      matches++;
    }
  }
  return { matches, limitHit: false };
}
