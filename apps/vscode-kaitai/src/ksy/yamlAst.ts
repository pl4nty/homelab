// YAML position helpers for .ksy documents: path <-> offset mapping and outline symbols. Pure.
import { type Document, isMap, isScalar, isSeq, LineCounter, type Node, type Pair, parseDocument } from 'yaml';

export interface ParsedKsy {
  doc: Document.Parsed;
  lines: LineCounter;
  /** `doc.toJS()`, or undefined if that failed. */
  // biome-ignore lint/suspicious/noExplicitAny: parsed YAML
  js: any;
}

export function parseKsyDocument(text: string): ParsedKsy {
  const lines = new LineCounter();
  const doc = parseDocument(text, {
    lineCounter: lines,
    uniqueKeys: false,
    keepSourceTokens: true,
    prettyErrors: false,
  });
  let js: unknown;
  try {
    js = doc.toJS({ maxAliasCount: -1 });
  } catch {
    js = undefined;
  }
  return { doc, lines, js };
}

export interface OffsetRange {
  start: number;
  end: number;
}

const rangeOf = (n: Node | null | undefined): OffsetRange | undefined =>
  n?.range ? { start: n.range[0], end: n.range[1] } : undefined;

/** Value of a scalar key (keys are usually scalars), as a string. */
export function keyText(pair: Pair): string | undefined {
  const k = pair.key;
  if (isScalar(k)) return String(k.value);
  return typeof k === 'string' || typeof k === 'number' ? String(k) : undefined;
}

function findPair(map: Node, key: string): Pair<Node, Node> | undefined {
  if (!isMap(map)) return undefined;
  for (const p of map.items) if (keyText(p) === key) return p as Pair<Node, Node>;
  return undefined;
}

/** First line of a range, so block collections do not underline whole sections. */
function firstLine(text: string, r: OffsetRange): OffsetRange {
  const nl = text.indexOf('\n', r.start);
  return { start: r.start, end: nl >= 0 && nl < r.end ? nl : r.end };
}

export interface PathRange extends OffsetRange {
  /** How much of the path was found: `value`/`key` (full path) or `ancestor` (a prefix). */
  match: 'value' | 'key' | 'ancestor';
}

/**
 * Text range for a YAML path such as `['seq', '2', 'type']`. Prefers a scalar value, then the key,
 * then the deepest ancestor that exists.
 */
export function rangeForPath(parsed: ParsedKsy, text: string, path: readonly string[]): PathRange {
  let node: Node | null | undefined = parsed.doc.contents as Node | null;
  let lastKey: Node | undefined;
  let best: OffsetRange | undefined;
  for (let i = 0; i < path.length; i++) {
    const seg = path[i];
    let next: Node | null | undefined;
    let key: Node | undefined;
    if (isMap(node)) {
      const p = findPair(node, seg);
      if (p) {
        key = isScalar(p.key) ? p.key : undefined;
        next = p.value;
        if (!next) {
          // `key:` with no value
          const r = rangeOf(key);
          if (r && i === path.length - 1) return { ...r, match: 'key' };
        }
      }
    } else if (isSeq(node) && /^\d+$/.test(seg)) {
      next = node.items[Number(seg)] as Node | undefined;
    }
    if (!next && !key) {
      const r = rangeOf(lastKey) ?? (node ? itemHead(text, node) : undefined) ?? best;
      return { ...(r ?? { start: 0, end: firstLine(text, { start: 0, end: text.length }).end }), match: 'ancestor' };
    }
    best = rangeOf(key) ?? best;
    lastKey = key;
    node = next;
  }
  if (isScalar(node)) {
    const r = rangeOf(node);
    if (r) return { ...r, match: 'value' };
  }
  if (lastKey) {
    const r = rangeOf(lastKey);
    if (r) return { ...r, match: 'key' };
  }
  const r = node ? itemHead(text, node) : undefined;
  return { ...(r ?? { start: 0, end: firstLine(text, { start: 0, end: text.length }).end }), match: 'value' };
}

/** For a list item mapping, the `id` value; otherwise the first line of the node. */
function itemHead(text: string, node: Node): OffsetRange | undefined {
  if (isMap(node)) {
    const id = findPair(node, 'id');
    const r = rangeOf(id?.value) ?? rangeOf(id?.key as Node);
    if (r) return r;
  }
  const r = rangeOf(node);
  return r && firstLine(text, r);
}

export interface NodeAt {
  /** YAML path from the document root (list indices as numbers in string form). */
  path: string[];
  /** The offset is on a mapping key (the last path element) rather than its value. */
  onKey: boolean;
  /** Scalar under the offset, if any. */
  scalar?: { value: string; range: OffsetRange };
}

/** The deepest node containing `offset`. */
export function nodeAt(parsed: ParsedKsy, offset: number): NodeAt | undefined {
  const path: string[] = [];
  const inside = (n: unknown) => {
    const r = (n as Node | null)?.range;
    return !!r && r[0] <= offset && offset <= r[1];
  };
  let node: unknown = parsed.doc.contents;
  if (!inside(node)) return undefined;
  for (;;) {
    if (isMap(node)) {
      let nextNode: unknown;
      for (const p of node.items) {
        if (isScalar(p.key) && inside(p.key)) {
          const k = keyText(p) ?? '';
          path.push(k);
          return { path, onKey: true, scalar: { value: k, range: rangeOf(p.key as Node) as OffsetRange } };
        }
        if (inside(p.value)) {
          path.push(keyText(p) ?? '');
          nextNode = p.value;
          break;
        }
      }
      if (nextNode === undefined) return { path, onKey: false };
      node = nextNode;
    } else if (isSeq(node)) {
      const i = node.items.findIndex((it) => inside(it));
      if (i < 0) return { path, onKey: false };
      path.push(String(i));
      node = node.items[i];
    } else if (isScalar(node)) {
      return { path, onKey: false, scalar: { value: String(node.value ?? ''), range: rangeOf(node) as OffsetRange } };
    } else {
      return { path, onKey: false };
    }
  }
}

/** The key and value nodes of the mapping entry at `path`. */
export function pairAt(parsed: ParsedKsy, path: readonly string[]): { key?: OffsetRange; value?: Node } | undefined {
  let node: unknown = parsed.doc.contents;
  let key: OffsetRange | undefined;
  for (const seg of path) {
    if (isMap(node)) {
      const p = findPair(node, seg);
      if (!p) return undefined;
      key = rangeOf(p.key as Node);
      node = p.value;
    } else if (isSeq(node) && /^\d+$/.test(seg)) {
      node = node.items[Number(seg)];
      key = undefined;
      if (node === undefined) return undefined;
    } else {
      return undefined;
    }
  }
  return { key, value: (node ?? undefined) as Node | undefined };
}

/** Range of a type's key (`types: { chunk: ... }`) by nested type path; `[]` gives meta/id. */
export function typeKeyRange(parsed: ParsedKsy, typePath: readonly string[]): OffsetRange | undefined {
  if (!typePath.length) return valueOrKey(parsed, ['meta', 'id']);
  return pairAt(
    parsed,
    typePath.flatMap((t) => ['types', t]),
  )?.key;
}

function valueOrKey(parsed: ParsedKsy, path: readonly string[]): OffsetRange | undefined {
  const p = pairAt(parsed, path);
  return (p?.value && isScalar(p.value) ? rangeOf(p.value) : undefined) ?? p?.key;
}

/** Range of a field id: the `id` value of a seq/params item, or an instance key. */
export function fieldRange(parsed: ParsedKsy, typePath: readonly string[], field: string): OffsetRange | undefined {
  const base = typePath.flatMap((t) => ['types', t]);
  for (const list of ['seq', 'params']) {
    const seq = pairAt(parsed, [...base, list])?.value;
    if (isSeq(seq)) {
      for (const item of seq.items) {
        const id = isMap(item) ? findPair(item as Node, 'id') : undefined;
        if (id && isScalar(id.value) && String(id.value.value) === field) return rangeOf(id.value);
      }
    }
  }
  return pairAt(parsed, [...base, 'instances', field])?.key;
}

/** Range of an enum key, or of one of its values when `label` is given. */
export function enumRange(parsed: ParsedKsy, typePath: readonly string[], name: string, label?: string) {
  const path = [...typePath.flatMap((t) => ['types', t]), 'enums', name];
  const p = pairAt(parsed, path);
  if (!p || label === undefined) return p?.key;
  if (isMap(p.value)) {
    for (const item of p.value.items) {
      const v = item.value;
      const id = isScalar(v) ? String(v.value) : isMap(v) ? findPair(v as Node, 'id')?.value : undefined;
      const text = typeof id === 'string' ? id : isScalar(id) ? String(id.value) : undefined;
      if (text === label) return rangeOf(item.key as Node);
    }
  }
  return p.key;
}

// ---------------------------------------------------------------------------------------------
// Outline

export type SymbolKind = 'module' | 'field' | 'property' | 'class' | 'enum' | 'enumMember' | 'variable' | 'namespace';

export interface KsySymbol {
  name: string;
  detail?: string;
  kind: SymbolKind;
  range: OffsetRange;
  selectionRange: OffsetRange;
  children: KsySymbol[];
}

function pairRange(p: Pair): OffsetRange | undefined {
  const k = rangeOf(p.key as Node);
  const v = rangeOf(p.value as Node);
  if (!k) return undefined;
  return { start: k.start, end: Math.max(k.end, v?.end ?? k.end) };
}

function scalarDetail(n: unknown): string | undefined {
  return isScalar(n) && n.value !== null ? String(n.value) : undefined;
}

function attrDetail(attr: Node): string | undefined {
  if (!isMap(attr)) return undefined;
  const type = findPair(attr, 'type')?.value;
  let detail = isScalar(type) ? String(type.value) : isMap(type) ? 'switch' : undefined;
  if (!detail && findPair(attr, 'contents')) detail = 'contents';
  if (!detail && findPair(attr, 'value')) detail = 'value';
  if (!detail && findPair(attr, 'size')) detail = 'bytes';
  const repeat = scalarDetail(findPair(attr, 'repeat')?.value);
  if (detail && repeat) detail += '[]';
  return detail;
}

function typeSymbols(text: string, node: Node | null | undefined): KsySymbol[] {
  const out: KsySymbol[] = [];
  if (!isMap(node)) return out;
  for (const p of node.items) {
    const key = keyText(p);
    const range = pairRange(p);
    const sel = rangeOf(p.key as Node);
    if (!key || !range || !sel) continue;
    const v = p.value as Node | null;
    switch (key) {
      case 'meta': {
        const id = isMap(v) ? scalarDetail(findPair(v, 'id')?.value) : undefined;
        out.push({ name: 'meta', detail: id, kind: 'module', range, selectionRange: sel, children: [] });
        break;
      }
      case 'seq':
      case 'params': {
        const children: KsySymbol[] = [];
        if (isSeq(v)) {
          for (const item of v.items) {
            if (!isMap(item)) continue;
            const idPair = findPair(item as Node, 'id');
            const r = rangeOf(item as Node);
            const s = rangeOf(idPair?.value as Node) ?? r;
            if (!r || !s) continue;
            children.push({
              name: scalarDetail(idPair?.value) ?? '(unnamed)',
              detail: attrDetail(item as Node),
              kind: key === 'seq' ? 'field' : 'variable',
              range: r,
              selectionRange: s,
              children: [],
            });
          }
        }
        out.push({ name: key, kind: 'namespace', range, selectionRange: sel, children });
        break;
      }
      case 'instances': {
        const children: KsySymbol[] = [];
        if (isMap(v)) {
          for (const ip of v.items) {
            const r = pairRange(ip);
            const s = rangeOf(ip.key as Node);
            const name = keyText(ip);
            if (r && s && name) {
              children.push({
                name,
                detail: attrDetail(ip.value as Node),
                kind: 'property',
                range: r,
                selectionRange: s,
                children: [],
              });
            }
          }
        }
        out.push({ name: 'instances', kind: 'namespace', range, selectionRange: sel, children });
        break;
      }
      case 'types': {
        const children: KsySymbol[] = [];
        if (isMap(v)) {
          for (const tp of v.items) {
            const r = pairRange(tp);
            const s = rangeOf(tp.key as Node);
            const name = keyText(tp);
            if (r && s && name) {
              children.push({
                name,
                kind: 'class',
                range: r,
                selectionRange: s,
                children: typeSymbols(text, tp.value as Node),
              });
            }
          }
        }
        out.push({ name: 'types', kind: 'namespace', range, selectionRange: sel, children });
        break;
      }
      case 'enums': {
        const children: KsySymbol[] = [];
        if (isMap(v)) {
          for (const ep of v.items) {
            const r = pairRange(ep);
            const s = rangeOf(ep.key as Node);
            const name = keyText(ep);
            if (!r || !s || !name) continue;
            const members: KsySymbol[] = [];
            if (isMap(ep.value)) {
              for (const mp of ep.value.items) {
                const mr = pairRange(mp);
                const ms = rangeOf(mp.key as Node);
                const mv = mp.value as Node | null;
                const label = isScalar(mv)
                  ? String(mv.value)
                  : isMap(mv)
                    ? scalarDetail(findPair(mv, 'id')?.value)
                    : undefined;
                if (mr && ms) {
                  members.push({
                    name: label ?? '?',
                    detail: keyText(mp),
                    kind: 'enumMember',
                    range: mr,
                    selectionRange: ms,
                    children: [],
                  });
                }
              }
            }
            children.push({ name, kind: 'enum', range: r, selectionRange: s, children: members });
          }
        }
        out.push({ name: 'enums', kind: 'namespace', range, selectionRange: sel, children });
        break;
      }
    }
  }
  return out;
}

/** Outline of a .ksy document. */
export function documentSymbols(parsed: ParsedKsy, text: string): KsySymbol[] {
  return typeSymbols(text, parsed.doc.contents as Node | null);
}

/** Entries of meta/imports with their ranges. */
export function importEntries(parsed: ParsedKsy): { name: string; range: OffsetRange }[] {
  const seq = pairAt(parsed, ['meta', 'imports'])?.value;
  const out: { name: string; range: OffsetRange }[] = [];
  if (isSeq(seq)) {
    for (const it of seq.items) {
      const r = rangeOf(it as Node);
      if (isScalar(it) && r) out.push({ name: String(it.value), range: r });
    }
  }
  return out;
}
