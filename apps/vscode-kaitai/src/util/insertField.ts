// Computes the text edit that inserts a `seq` entry into a .ksy spec. Pure (no vscode), so the
// "Add Field from Selection" command is unit-tested through it.
import { isMap, isScalar, isSeq, LineCounter, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml';

export interface FieldSpec {
  id: string;
  /** Extra attributes in order, e.g. { type: 'u2le' } or { size: 4 }. */
  attrs: Record<string, string | number>;
}

export interface InsertEdit {
  /** Character offset to insert at. */
  offset: number;
  text: string;
}

const camel = (id: string) =>
  id
    .split('_')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');

/** Finds the mapping of the type whose generated class name is `className`. */
export function findTypeMap(source: string, className: string): YAMLMap | undefined {
  const doc = parseDocument(source, { keepSourceTokens: true });
  const root = doc.contents;
  if (!isMap(root)) return undefined;
  const id = root.getIn(['meta', 'id']);
  if (typeof id === 'string' && camel(id) === className) return root;
  const visit = (m: YAMLMap): YAMLMap | undefined => {
    const types = m.get('types', true);
    if (!isMap(types)) return undefined;
    for (const pair of types.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : undefined;
      if (!isMap(pair.value)) continue;
      if (key && camel(key) === className) return pair.value;
      const inner = visit(pair.value);
      if (inner) return inner;
    }
    return undefined;
  };
  return visit(root);
}

/**
 * Builds an edit that inserts `fields` into the `seq` of type `className`, before the item at
 * `index` (or at the end). The seq must exist in block style.
 */
export function insertSeqItems(
  source: string,
  className: string,
  index: number,
  fields: FieldSpec[],
): InsertEdit | string {
  const map = findTypeMap(source, className);
  if (!map) return `Type ${className} is not defined in this spec (it may be imported).`;
  const seq = map.get('seq', true) as YAMLSeq | undefined;
  if (!seq || !isSeq(seq)) return `Type ${className} has no seq list to add to.`;
  if (seq.flow) return `The seq of ${className} uses flow style ([...]); convert it to block style first.`;
  const lc = new LineCounter();
  parseDocument(source, { lineCounter: lc });
  const items = seq.items as { range?: [number, number, number] }[];
  // Indent of the "- " marker: from the first item's line.
  const firstStart = items[0]?.range?.[0] ?? seq.range?.[0] ?? 0;
  const lineStart = source.lastIndexOf('\n', firstStart - 1) + 1;
  const dashCol = source.slice(lineStart, firstStart).indexOf('-');
  const indent = ' '.repeat(Math.max(dashCol, 0));
  const render = (f: FieldSpec) =>
    [`${indent}- id: ${f.id}`, ...Object.entries(f.attrs).map(([k, v]) => `${indent}  ${k}: ${v}`)].join('\n');
  const text = `${fields.map(render).join('\n')}\n`;
  if (index < items.length) {
    const start = items[index].range![0];
    const ls = source.lastIndexOf('\n', start - 1) + 1;
    return { offset: ls, text };
  }
  // After the last item: at the start of the line following its end.
  const end = items.length ? items[items.length - 1].range![1] : seq.range![1];
  let offset = source.indexOf('\n', Math.max(end - 1, 0));
  // Trailing comments or blank lines belong to the next key; insert right after the item's last line.
  offset = offset < 0 ? source.length : offset + 1;
  const prefix = offset === source.length && !source.endsWith('\n') ? '\n' : '';
  return { offset, text: prefix + text };
}

/** Field types offered for a selection of `length` bytes. */
export function typeChoices(
  length: number,
  endian?: string,
): { label: string; attrs: Record<string, string | number> }[] {
  const out: { label: string; attrs: Record<string, string | number> }[] = [];
  const ends = endian === 'be' ? ['be', 'le'] : ['le', 'be'];
  if ([1, 2, 4, 8].includes(length)) {
    for (const s of ['u', 's']) {
      if (length === 1) out.push({ label: `${s}1`, attrs: { type: `${s}1` } });
      else
        for (const e of ends)
          out.push({
            label: `${s}${length}${e}`,
            attrs: { type: endian === e ? `${s}${length}` : `${s}${length}${e}` },
          });
    }
  }
  if (length === 4 || length === 8)
    for (const e of ends)
      out.push({ label: `f${length}${e}`, attrs: { type: endian === e ? `f${length}` : `f${length}${e}` } });
  out.push({ label: `bytes (size: ${length})`, attrs: { size: length } });
  out.push({ label: `str UTF-8 (size: ${length})`, attrs: { type: 'str', size: length, encoding: 'UTF-8' } });
  out.push({ label: 'strz UTF-8', attrs: { type: 'strz', encoding: 'UTF-8' } });
  return out;
}
