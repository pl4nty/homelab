// YAML position helpers for .ksy documents: path <-> offset mapping and outline symbols. Pure.
import type * as vscode from 'vscode';
import { type Document, isMap, isScalar, isSeq, LineCounter, type Node, type Pair, parseDocument } from 'yaml';
import { buildTypeTree, type TypeInfo } from './model.ts';

export interface ParsedKsy {
  doc: Document.Parsed;
  lines: LineCounter;
  /** `doc.toJS()`, or undefined if that failed. */
  // biome-ignore lint/suspicious/noExplicitAny: parsed YAML
  js: any;
  /** Type tree of `js`. */
  root: TypeInfo;
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
  return { doc, lines, js, root: buildTypeTree(js) };
}

export interface OffsetRange {
  start: number;
  end: number;
}

const rangeOf = (n: unknown): OffsetRange | undefined => {
  const r = (n as Node | null | undefined)?.range;
  return r ? { start: r[0], end: r[1] } : undefined;
};

const keyText = (pair: Pair): string | undefined => (isScalar(pair.key) ? String(pair.key.value) : undefined);

const scalarText = (n: unknown): string | undefined => (isScalar(n) && n.value !== null ? String(n.value) : undefined);

function findPair(map: unknown, key: string): Pair | undefined {
  return isMap(map) ? map.items.find((p) => keyText(p) === key) : undefined;
}

/** YAML path of a nested type: `['a', 'b']` -> `['types', 'a', 'types', 'b']`. */
const typeNodePath = (typePath: readonly string[]) => typePath.flatMap((t) => ['types', t]);

/**
 * Follows `path` from the document root as far as it exists. Returns the node reached, the key
 * node of the mapping entry that holds it (if it is one), and whether the whole path was found.
 */
function walk(parsed: ParsedKsy, path: readonly string[]): { node: unknown; key?: unknown; found: boolean } {
  let node: unknown = parsed.doc.contents;
  let key: unknown;
  for (const seg of path) {
    if (isMap(node)) {
      const p = findPair(node, seg);
      if (!p) return { node, key, found: false };
      key = p.key;
      node = p.value;
    } else if (isSeq(node) && /^\d+$/.test(seg) && Number(seg) < node.items.length) {
      key = undefined;
      node = node.items[Number(seg)];
    } else {
      return { node, key, found: false };
    }
  }
  return { node, key, found: true };
}

/** The key range and value node of the entry at `path`, if it exists. */
function entryAt(parsed: ParsedKsy, path: readonly string[]): { key?: OffsetRange; value: unknown } | undefined {
  const { node, key, found } = walk(parsed, path);
  return found ? { key: rangeOf(key), value: node } : undefined;
}

export interface PathRange extends OffsetRange {
  /** How much of the path was found: `value`/`key` (full path) or `ancestor` (a prefix). */
  match: 'value' | 'key' | 'ancestor';
}

/**
 * Text range for a YAML path such as `['seq', '2', 'type']`. Prefers a scalar value, then the key,
 * then the deepest ancestor that exists. List items are shown by their `id`, and other block
 * collections by their first line, so that an error does not underline a whole section.
 */
export function rangeForPath(parsed: ParsedKsy, text: string, path: readonly string[]): PathRange {
  const { node, key, found } = walk(parsed, path);
  const value = found && isScalar(node) ? rangeOf(node) : undefined;
  // An empty value (`type:`) has an empty range; its key is the better place.
  if (value && (value.end > value.start || !key)) return { ...value, match: 'value' };
  const head = rangeOf(key) ?? rangeOf(findPair(node, 'id')?.value) ?? rangeOf(node) ?? { start: 0, end: text.length };
  const nl = text.indexOf('\n', head.start);
  return {
    start: head.start,
    end: nl >= 0 && nl < head.end ? nl : head.end,
    match: !found ? 'ancestor' : key ? 'key' : 'value',
  };
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
  const inside = (n: unknown) => {
    const r = rangeOf(n);
    return !!r && r.start <= offset && offset <= r.end;
  };
  const scalarAt = (n: Node, value: string) => ({ value, range: rangeOf(n) as OffsetRange });
  const path: string[] = [];
  let node: unknown = parsed.doc.contents;
  if (!inside(node)) return undefined;
  for (;;) {
    if (isMap(node)) {
      const onKey = node.items.find((p) => isScalar(p.key) && inside(p.key));
      const p = onKey ?? node.items.find((p) => inside(p.value));
      if (!p) return { path, onKey: false };
      const key = keyText(p) ?? '';
      path.push(key);
      if (onKey) return { path, onKey: true, scalar: scalarAt(p.key as Node, key) };
      node = p.value;
    } else if (isSeq(node)) {
      const i = node.items.findIndex(inside);
      if (i < 0) return { path, onKey: false };
      path.push(String(i));
      node = node.items[i];
    } else {
      return { path, onKey: false, scalar: isScalar(node) ? scalarAt(node, String(node.value ?? '')) : undefined };
    }
  }
}

/** Range of a type's key (`types: { chunk: ... }`) by nested type path; `[]` gives the meta/id value. */
export function typeKeyRange(parsed: ParsedKsy, typePath: readonly string[]): OffsetRange | undefined {
  if (typePath.length) return entryAt(parsed, typeNodePath(typePath))?.key;
  const id = entryAt(parsed, ['meta', 'id']);
  return (isScalar(id?.value) ? rangeOf(id.value) : undefined) ?? id?.key;
}

/** Range of a field id: the `id` value of a seq/params item, or an instance key. */
export function fieldRange(parsed: ParsedKsy, typePath: readonly string[], field: string): OffsetRange | undefined {
  const base = typeNodePath(typePath);
  for (const list of ['seq', 'params']) {
    const items = entryAt(parsed, [...base, list])?.value;
    for (const item of isSeq(items) ? items.items : []) {
      const id = findPair(item, 'id')?.value;
      if (scalarText(id) === field) return rangeOf(id);
    }
  }
  return entryAt(parsed, [...base, 'instances', field])?.key;
}

/** Label of an enum member: `1: label` or `1: { id: label }`. */
const enumLabel = (value: unknown) => scalarText(isMap(value) ? findPair(value, 'id')?.value : value);

/** Range of an enum key, or of the key of its member `label` when that is given and exists. */
export function enumRange(
  parsed: ParsedKsy,
  typePath: readonly string[],
  name: string,
  label?: string,
): OffsetRange | undefined {
  const e = entryAt(parsed, [...typeNodePath(typePath), 'enums', name]);
  const member =
    label !== undefined && isMap(e?.value) ? e.value.items.find((m) => enumLabel(m.value) === label) : undefined;
  return rangeOf(member?.key) ?? e?.key;
}

/** Entries of meta/imports with their ranges. */
export function importEntries(parsed: ParsedKsy): { name: string; range: OffsetRange }[] {
  const seq = entryAt(parsed, ['meta', 'imports'])?.value;
  return (isSeq(seq) ? seq.items : []).flatMap((it) => {
    const range = rangeOf(it);
    return isScalar(it) && range ? [{ name: String(it.value), range }] : [];
  });
}

// ---------------------------------------------------------------------------------------------
// Outline

export interface KsySymbol {
  name: string;
  detail?: string;
  kind: keyof typeof vscode.SymbolKind;
  range: OffsetRange;
  selectionRange: OffsetRange;
  children: KsySymbol[];
}

type SymbolParts = Pick<KsySymbol, 'name' | 'range' | 'selectionRange'> & { value: unknown };

/** Named entries of a mapping: the key is the selection, key to end of value the range. */
function mapEntries(map: unknown): SymbolParts[] {
  return (isMap(map) ? map.items : []).flatMap((p) => {
    const name = keyText(p);
    const sel = rangeOf(p.key);
    if (!name || !sel) return [];
    const end = Math.max(sel.end, rangeOf(p.value)?.end ?? 0);
    return [{ name, range: { start: sel.start, end }, selectionRange: sel, value: p.value }];
  });
}

/** Mapping items of a list (attributes), named and selected by their `id`. */
function listEntries(seq: unknown): SymbolParts[] {
  return (isSeq(seq) ? seq.items : []).flatMap((item) => {
    const range = rangeOf(item);
    if (!isMap(item) || !range) return [];
    const id = findPair(item, 'id')?.value;
    return [{ name: scalarText(id) || '(unnamed)', range, selectionRange: rangeOf(id) ?? range, value: item }];
  });
}

const symbol = (
  { value: _, ...parts }: SymbolParts,
  kind: KsySymbol['kind'],
  detail?: string,
  children: KsySymbol[] = [],
): KsySymbol => ({ ...parts, kind, detail, children });

/** Short type summary of an attribute: `u4`, `chunk[]`, `switch`, `bytes`... */
function attrDetail(attr: unknown): string | undefined {
  const type = findPair(attr, 'type')?.value;
  const detail =
    scalarText(type) ??
    (isMap(type) ? 'switch' : undefined) ??
    ['contents', 'value'].find((k) => findPair(attr, k)) ??
    (findPair(attr, 'size') ? 'bytes' : undefined);
  return detail && scalarText(findPair(attr, 'repeat')?.value) ? `${detail}[]` : detail;
}

function typeSymbols(type: unknown): KsySymbol[] {
  return mapEntries(type).flatMap((section) => {
    const v = section.value;
    switch (section.name) {
      case 'meta':
        return [symbol(section, 'Module', scalarText(findPair(v, 'id')?.value))];
      case 'seq':
      case 'params': {
        const kind = section.name === 'seq' ? 'Field' : 'Variable';
        const children = listEntries(v).map((a) => symbol(a, kind, attrDetail(a.value)));
        return [symbol(section, 'Namespace', undefined, children)];
      }
      case 'instances': {
        const children = mapEntries(v).map((i) => symbol(i, 'Property', attrDetail(i.value)));
        return [symbol(section, 'Namespace', undefined, children)];
      }
      case 'types': {
        const children = mapEntries(v).map((t) => symbol(t, 'Class', undefined, typeSymbols(t.value)));
        return [symbol(section, 'Namespace', undefined, children)];
      }
      case 'enums': {
        const members = (e: SymbolParts) =>
          mapEntries(e.value).map((m) => symbol({ ...m, name: enumLabel(m.value) || '?' }, 'EnumMember', m.name));
        const children = mapEntries(v).map((e) => symbol(e, 'Enum', undefined, members(e)));
        return [symbol(section, 'Namespace', undefined, children)];
      }
      default:
        return [];
    }
  });
}

/** Outline of a .ksy document. */
export function documentSymbols(parsed: ParsedKsy): KsySymbol[] {
  return typeSymbols(parsed.doc.contents);
}
