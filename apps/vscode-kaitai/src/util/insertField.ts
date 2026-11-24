// Computes the text edit that inserts a `seq` entry into a .ksy spec. Pure (no vscode), so the
// "Add Field from Selection" command is unit-tested through it.
import { isMap, isScalar, isSeq, type Node, parseDocument, type YAMLMap } from 'yaml';
import { toUpperCamel } from './names.ts';

type Attrs = Record<string, string | number>;

export interface FieldSpec {
  id: string;
  /** Extra attributes in order, e.g. { type: 'u2le' } or { size: 4 }. */
  attrs: Attrs;
}

export interface InsertEdit {
  /** Character offset to insert at. */
  offset: number;
  text: string;
}

/** Finds the mapping of the type whose generated class name is `className`. */
function findTypeMap(source: string, className: string): YAMLMap | undefined {
  const root = parseDocument(source).contents;
  if (!isMap(root)) return undefined;
  const visit = (name: unknown, map: YAMLMap): YAMLMap | undefined => {
    if (typeof name === 'string' && toUpperCamel(name) === className) return map;
    const types = map.get('types', true);
    for (const pair of isMap(types) ? types.items : []) {
      const found = isMap(pair.value) && visit(isScalar(pair.key) ? pair.key.value : undefined, pair.value);
      if (found) return found;
    }
    return undefined;
  };
  return visit(root.getIn(['meta', 'id']), root);
}

/**
 * Builds an edit that inserts `fields` into the `seq` of type `className`, before the field with
 * id `before` (or at the end, when there is none). The seq must exist in block style.
 */
export function insertSeqItems(
  source: string,
  className: string,
  before: string | undefined,
  fields: FieldSpec[],
): InsertEdit | string {
  const map = findTypeMap(source, className);
  if (!map) return `Type ${className} is not defined in this spec (it may be imported).`;
  const seq = map.get('seq', true);
  if (!isSeq(seq)) return `Type ${className} has no seq list to add to.`;
  if (seq.flow) return `The seq of ${className} uses flow style ([...]); convert it to block style first.`;
  // A block sequence has at least one item, and parsed nodes have ranges.
  const starts = (seq.items as Node[]).map((item) => (item.range as [number, number, number])[0]);
  const lineStart = (offset: number) => source.lastIndexOf('\n', offset - 1) + 1;
  // An item's range starts after its "- " marker.
  const indent = ' '.repeat(source.slice(lineStart(starts[0]), starts[0]).indexOf('-'));
  const text = fields
    .flatMap((f) => [`- id: ${f.id}`, ...Object.entries(f.attrs).map(([k, v]) => `  ${k}: ${v}`)])
    .map((line) => `${indent}${line}\n`)
    .join('');
  const next = seq.items.findIndex((item) => before !== undefined && isMap(item) && item.get('id') === before);
  if (next >= 0) return { offset: lineStart(starts[next]), text };
  // At the end: after the last line of the last item. Comments or blank lines that follow belong
  // to the next key.
  const end = (seq.items.at(-1) as Node).range?.[1] ?? source.length;
  const newline = source.indexOf('\n', Math.max(end - 1, 0));
  return newline < 0 ? { offset: source.length, text: `\n${text}` } : { offset: newline + 1, text };
}

/** Field types offered for a selection of `length` bytes. */
export function typeChoices(length: number, endian?: string): { label: string; attrs: Attrs }[] {
  const ends = endian === 'be' ? ['be', 'le'] : ['le', 'be'];
  // The spec's default endianness needs no suffix.
  const numeric = (base: string) =>
    length === 1
      ? [{ label: base, attrs: { type: base } }]
      : ends.map((e) => ({ label: base + e, attrs: { type: e === endian ? base : base + e } }));
  return [
    ...([1, 2, 4, 8].includes(length) ? ['u', 's'] : []).flatMap((sign) => numeric(`${sign}${length}`)),
    ...(length === 4 || length === 8 ? numeric(`f${length}`) : []),
    { label: `bytes (size: ${length})`, attrs: { size: length } },
    { label: `str UTF-8 (size: ${length})`, attrs: { type: 'str', size: length, encoding: 'UTF-8' } },
    { label: 'strz UTF-8', attrs: { type: 'strz', encoding: 'UTF-8' } },
  ];
}
