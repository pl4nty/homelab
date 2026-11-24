// Completion for .ksy files. Context detection works on raw text (indentation and flow brackets),
// because the line being typed is usually not valid YAML yet. Pure (no vscode).
import type * as vscode from 'vscode';
import {
  BUILTIN_TYPES,
  describeBuiltin,
  EXPRESSION_BUILTINS,
  enumMembers,
  fieldsOf,
  IO_MEMBERS,
  PROCESS_VALUES,
  resolveEnum,
  resolveType,
  type TypeInfo,
  typeAt,
  visibleEnums,
  visibleTypes,
  walkChain,
} from './model.ts';
import { classifyPath, ENCODINGS, isExpressionSlot, isTypeSlot, keyInfo, keysFor, type PathContext } from './schema.ts';
import { parseKsyDocument } from './yamlAst.ts';

export interface CompletionContext {
  mode: 'key' | 'value';
  /** Path of the mapping (key mode) or of the value slot (value mode); `*` for list items. */
  path: string[];
  /** Keys already present in the mapping (key mode). */
  existing: string[];
  /** Text typed so far for the current key or value. */
  prefix: string;
  /** Inside a flow collection (`{ ... }` / `[ ... ]`) on the current line. */
  flow: boolean;
  /** Indentation (columns) of the key being typed, for multi-line snippets. */
  indent: number;
  classified: PathContext;
}

interface LineInfo {
  blank: boolean;
  indent: number;
  /** Columns of `- ` list markers. */
  dashes: number[];
  /** Column where the content after the markers starts. */
  contentCol: number;
  key?: string;
  /** Text after `key:` (comments stripped). */
  value?: string;
  /** Rest of the line after the markers (when there is no key). */
  rest: string;
}

const KEY_RE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"{[\]},&*!|>%@`-][^#]*?|-[^\s#][^#]*?)\s*:(?:\s+|$)(.*)$/;

function unquote(k: string) {
  if (k.startsWith('"') && k.endsWith('"')) return k.slice(1, -1);
  if (k.startsWith("'") && k.endsWith("'")) return k.slice(1, -1).replace(/''/g, "'");
  return k;
}

function stripComment(s: string) {
  // Good enough: a `#` that starts a comment is preceded by whitespace or starts the text.
  const m = /(^|\s)#/.exec(s);
  return (m ? s.slice(0, m.index) : s).trimEnd();
}

function parseLine(line: string): LineInfo {
  const indent = /^ */.exec(line)?.[0].length ?? 0;
  const dashes: number[] = [];
  let i = indent;
  while (line[i] === '-' && (i + 1 === line.length || line[i + 1] === ' ' || line[i + 1] === '\t')) {
    dashes.push(i);
    i++;
    while (line[i] === ' ' || line[i] === '\t') i++;
  }
  const rest = line.slice(i);
  const blank = rest.trim() === '' || rest.trimStart().startsWith('#');
  const m = KEY_RE.exec(rest);
  if (m)
    return { blank: false, indent, dashes, contentCol: i, key: unquote(m[1].trim()), value: stripComment(m[2]), rest };
  return { blank: blank && !dashes.length, indent, dashes, contentCol: i, rest };
}

/** Path of the block mapping/list that contains content starting at `col` on line `lineNo`. */
function blockParents(lines: readonly string[], lineNo: number, col: number, targetIsDash: boolean): string[] {
  const path: string[] = [];
  let target = col;
  let dashTarget = targetIsDash;
  for (let i = lineNo - 1; i >= 0; i--) {
    const li = parseLine(lines[i]);
    if (li.blank) continue;
    if (li.indent === 0 && !li.dashes.length && li.key === undefined && li.rest.startsWith('---')) break;
    // Positions on the line, innermost first.
    const positions: { col: number; key?: string; hasValue?: boolean }[] = [];
    if (li.key !== undefined) positions.push({ col: li.contentCol, key: li.key, hasValue: !!li.value });
    for (let d = li.dashes.length - 1; d >= 0; d--) positions.push({ col: li.dashes[d] });
    for (const p of positions) {
      const parentKey = p.key !== undefined && (p.col < target || (dashTarget && p.col === target && !p.hasValue));
      if (parentKey) {
        path.unshift(p.key as string);
        target = p.col;
        dashTarget = false;
      } else if (p.key === undefined && p.col < target) {
        path.unshift('*');
        target = p.col;
        dashTarget = true;
      }
    }
    if (target === 0 && !dashTarget) break;
  }
  return path;
}

/** Keys of the block mapping whose keys start at `col`, around line `lineNo`. */
function siblingKeys(lines: readonly string[], lineNo: number, col: number): string[] {
  const keys: string[] = [];
  for (let i = lineNo - 1; i >= 0; i--) {
    const li = parseLine(lines[i]);
    if (li.blank || li.contentCol > col) continue;
    if (li.contentCol < col) break;
    if (li.key !== undefined) keys.push(li.key);
    if (li.dashes.length) break; // start of our list item
  }
  for (let i = lineNo + 1; i < lines.length; i++) {
    const li = parseLine(lines[i]);
    if (li.blank || li.contentCol > col) continue;
    if (li.contentCol < col || li.dashes.length) break;
    if (li.key !== undefined) keys.push(li.key);
  }
  return keys;
}

interface FlowFrame {
  kind: 'map' | 'list';
  key?: string;
  keys: string[];
}

/** Detects what is being completed at `offset`. */
export function completionContext(text: string, offset: number): CompletionContext {
  const lines = text.split('\n');
  const lineNo = text.slice(0, offset).split('\n').length - 1;
  const before = text.slice(text.lastIndexOf('\n', offset - 1) + 1, offset);
  const li = parseLine(before);

  // Scan the content after the list markers for flow collections.
  const content = before.slice(li.contentCol);
  const frames: FlowFrame[] = [];
  let blockKey: string | undefined;
  let segStart = 0;
  let quote: string | undefined;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (quote) {
      if (c === quote) quote = undefined;
      continue;
    }
    if (c === '"' || c === "'") {
      if (content.slice(segStart, i).trim() === '') quote = c;
      continue;
    }
    if (c === '#' && (i === 0 || /\s/.test(content[i - 1]))) break;
    const top = frames.at(-1);
    if (c === '{' || c === '[') {
      frames.push({ kind: c === '{' ? 'map' : 'list', keys: [] });
      segStart = i + 1;
    } else if (c === '}' || c === ']') {
      frames.pop();
      segStart = i + 1;
    } else if (c === ',' && top) {
      if (top.kind === 'map') top.key = undefined;
      segStart = i + 1;
    } else if (c === ':' && content[i - 1] !== ':' && (i + 1 >= content.length || /[\s,}\]]/.test(content[i + 1]))) {
      const key = unquote(content.slice(segStart, i).trim());
      if (top?.kind === 'map' && top.key === undefined) {
        top.key = key;
        top.keys.push(key);
        segStart = i + 1;
      } else if (!top && blockKey === undefined) {
        blockKey = key;
        segStart = i + 1;
      }
    }
  }
  const prefix = content.slice(segStart).trimStart().replace(/^["']/, '');

  const dashed = li.dashes.length > 0;
  const parentCol = dashed ? li.dashes[0] : li.contentCol;
  const path = blockParents(lines, lineNo, parentCol, dashed);
  for (let d = 0; d < li.dashes.length; d++) path.push('*');

  let mode: 'key' | 'value';
  let existing: string[] = [];
  const flow = frames.length > 0;
  if (flow) {
    if (blockKey !== undefined) path.push(blockKey);
    for (const fr of frames.slice(0, -1)) path.push(fr.kind === 'map' ? (fr.key ?? '?') : '*');
    const top = frames[frames.length - 1];
    if (top.kind === 'map' && top.key === undefined) {
      mode = 'key';
      existing = top.keys;
    } else {
      mode = 'value';
      path.push(top.key ?? '*');
    }
  } else if (blockKey !== undefined) {
    mode = 'value';
    path.push(blockKey);
  } else {
    mode = 'key';
    existing = dashed ? [] : siblingKeys(lines, lineNo, li.contentCol);
  }
  let classified = classifyPath(path);
  // A list item or key slot that holds scalars (imports, file-extension, doc-ref) is a value.
  if (mode === 'key' && (classified.ctx === 'scalar' || classified.ctx === 'imports')) mode = 'value';
  if (classified.key === '*') {
    // `imports: [a, |]` or `- |` under `imports:`: name the slot after the list's key.
    classified = { ...classified, key: path.filter((s) => s !== '*').at(-1) };
  }
  return { mode, path, existing, prefix, flow, indent: li.contentCol, classified };
}

// ---------------------------------------------------------------------------------------------

export interface KsyCompletion {
  label: string;
  kind: keyof typeof vscode.CompletionItemKind;
  detail?: string;
  doc?: string;
  /** Text to insert; a snippet when `snippet` is set. */
  insertText?: string;
  snippet?: boolean;
  sortText?: string;
  /** Suggest again after inserting (the value has completions of its own). */
  retrigger?: boolean;
}

const BLOCK_SNIPPET: Record<string, string> = {
  seq: `seq:\n%I  - id: $1\n%I    type: $0`,
  instances: `instances:\n%I  \${1:name}:\n%I    $0`,
  types: `types:\n%I  \${1:name}:\n%I    seq:\n%I      - id: $0`,
  enums: `enums:\n%I  \${1:name}:\n%I    0: $0`,
  params: `params:\n%I  - id: $1\n%I    type: $0`,
  meta: `meta:\n%I  id: $0`,
  xref: `xref:\n%I  $0`,
  imports: `imports:\n%I  - $0`,
  cases: `cases:\n%I  $0`,
};

/** Type tree of the document, built with the line being edited removed so the rest still parses. */
function modelFor(text: string, offset: number): TypeInfo {
  const start = text.lastIndexOf('\n', offset - 1) + 1;
  const end = text.indexOf('\n', offset);
  return parseKsyDocument(text.slice(0, start) + (end < 0 ? '' : text.slice(end))).root;
}

export interface CompletionResult {
  items: KsyCompletion[];
  /** Offset where the replaced text starts (the cursor is the end). */
  from: number;
}

export function computeCompletions(text: string, offset: number, imported: readonly TypeInfo[] = []): CompletionResult {
  const cc = completionContext(text, offset);
  const c = cc.classified;
  let items: KsyCompletion[];
  // The part of the prefix that a completion replaces: one name in an expression, else a whole reference.
  let word = /[\w:-]*$/;
  if (cc.mode === 'key') {
    items = keyCompletions(cc);
    word = /[\w-]*$/;
  } else if (!c.key) {
    items = [];
  } else {
    const scope = typeAt(modelFor(text, offset), c.typePath);
    const fixed = fixedValues(c, scope, imported);
    items = fixed ?? (isExpressionSlot(c) ? expressionCompletions(cc.prefix, scope, imported, c.key) : []);
    if (!fixed) word = /\w*$/;
  }
  return { items, from: offset - (word.exec(cc.prefix)?.[0].length ?? 0) };
}

const VALUE_KEYS = new Set(['type', 'enum', 'process', 'encoding', 'endian', 'bit-endian']);

const COMMON_KEYS = new Set([
  'id',
  'type',
  'size',
  'meta',
  'seq',
  'types',
  'enums',
  'instances',
  'repeat',
  'if',
  'enum',
  'title',
  'endian',
]);

function keyCompletions(cc: CompletionContext): KsyCompletion[] {
  const indent = ' '.repeat(cc.indent);
  return keysFor(cc.classified.ctx)
    .filter((k) => !cc.existing.includes(k.key))
    .map((k) => {
      const block = cc.flow ? undefined : BLOCK_SNIPPET[k.key];
      return {
        label: k.key,
        kind: 'Property',
        doc: k.doc,
        insertText: block ? block.replaceAll('%I', indent) : `${k.key}: `,
        snippet: !!block,
        retrigger: !block && (VALUE_KEYS.has(k.key) || k.values.length > 0) && k.key !== 'id',
        // Common keys first.
        sortText: `${COMMON_KEYS.has(k.key) ? '0' : '1'}${k.key}`,
      };
    });
}

const PARAM_TYPES = ['bytes', 'bool', 'struct', 'io', 'any'];

/** Completions for a value slot that takes names or literals; undefined if it takes something else. */
function fixedValues(c: PathContext, scope: TypeInfo, imported: readonly TypeInfo[]): KsyCompletion[] | undefined {
  const { key, parentCtx } = c;
  const value = (label: string, doc?: string): KsyCompletion => ({ label, kind: 'Value', doc });
  if (isTypeSlot(c)) {
    const builtins = [
      ...BUILTIN_TYPES,
      ...(parentCtx === 'param' ? PARAM_TYPES.map((name) => ({ name, doc: describeBuiltin(name) })) : []),
    ];
    return [
      ...builtins.map(
        (b): KsyCompletion => ({
          label: b.name,
          kind: 'Keyword',
          detail: 'built-in',
          doc: b.doc,
          sortText: `1${b.name}`,
        }),
      ),
      ...visibleTypes(scope, imported).map(
        ({ name, type }): KsyCompletion => ({
          label: name,
          kind: 'Class',
          detail: type.specId !== scope.specId ? `type from ${type.specId}` : 'user type',
          doc: typeof type.spec?.doc === 'string' ? type.spec.doc : undefined,
          sortText: `0${name}`,
        }),
      ),
    ];
  }
  switch (key) {
    case 'enum':
      return visibleEnums(scope, imported).map(({ name, ref }) => ({
        label: name,
        kind: 'Enum',
        detail: `enum in ${ref.owner.name || 'root'}`,
        doc: enumMembers(ref.spec)
          .slice(0, 20)
          .map((m) => `${m.value}: ${m.id}`)
          .join('\n'),
      }));
    case 'process':
      return PROCESS_VALUES.map((p) => {
        const insertText = p.name.replace(/\((\w+)\)/, `(\${1:$1})`);
        return { ...value(p.name, p.doc), insertText, snippet: insertText !== p.name };
      });
    case 'encoding':
      return ENCODINGS.map((e) => value(e));
    case 'endian':
    case 'bit-endian':
      return [value('le', 'little-endian'), value('be', 'big-endian')];
  }
  const values = (key !== 'id' && parentCtx && key && keyInfo(parentCtx, key)?.values) || [];
  return values.length ? values.map((v) => value(v)) : undefined;
}

const GENERIC_MEMBERS = [
  { name: 'length', doc: 'string length / array length' },
  { name: 'size', doc: 'number of items in an array, or bytes in a byte array' },
  { name: 'first', doc: 'first item of an array' },
  { name: 'last', doc: 'last item of an array' },
  { name: 'min', doc: 'smallest item of an array' },
  { name: 'max', doc: 'largest item of an array' },
  { name: 'to_s', doc: 'convert to string (integers; bytes with encoding)' },
  { name: 'to_i', doc: 'convert to integer (strings, floats, enums, booleans)' },
  { name: 'reverse', doc: 'reversed string' },
  { name: 'substring', doc: 'substring(from, to)' },
];

/** Completion inside an expression: fields, `_root`/`_parent`/`_io`, enum members after `::`. */
function expressionCompletions(
  prefix: string,
  scope: TypeInfo,
  imported: readonly TypeInfo[],
  key: string,
): KsyCompletion[] {
  const chain = (/((?:[A-Za-z_]\w*\s*(?:\.|::)\s*)*)\w*$/.exec(prefix)?.[1] ?? '').replace(/\s+/g, '');
  const fields = (t: TypeInfo) =>
    fieldsOf(t).map(
      (f): KsyCompletion => ({
        label: f.id,
        kind: 'Field',
        detail: `${f.kind}${typeof f.spec?.type === 'string' ? `: ${f.spec.type}` : ''}`,
        doc: typeof f.doc === 'string' ? f.doc : undefined,
        sortText: `0${f.id}`,
      }),
    );
  const keywords = (list: readonly { name: string; doc?: string }[], order: number) =>
    list.map((b): KsyCompletion => ({ label: b.name, kind: 'Keyword', doc: b.doc, sortText: `${order}${b.name}` }));
  const enums = (list: ReturnType<typeof visibleEnums>) =>
    list.map(
      ({ name, ref }): KsyCompletion => ({
        label: name,
        kind: 'Enum',
        detail: `enum in ${ref.owner.name}`,
        insertText: `${name}::`,
        sortText: `2${name}`,
      }),
    );

  if (!chain) {
    const current = key === 'repeat-until' || key === 'expr';
    return [
      ...fields(scope),
      ...keywords(
        EXPRESSION_BUILTINS.filter((b) => b.name !== '_' || current),
        1,
      ),
      ...enums(visibleEnums(scope, imported)),
      ...keywords(
        ['not', 'and', 'or', 'true', 'false'].map((name) => ({ name })),
        3,
      ),
    ];
  }
  if (chain.endsWith('::')) {
    const ref = chain.slice(0, -2);
    const e = resolveEnum(scope, ref, imported);
    if (e) {
      return enumMembers(e.spec).map((m) => ({ label: m.id, kind: 'EnumMember', detail: `= ${m.value}`, doc: m.doc }));
    }
    // `type::` lists that type's own enums.
    const t = resolveType(scope, ref, imported);
    return t ? enums(visibleEnums(t).filter((x) => x.ref.owner === t)) : [];
  }
  // Member access: walk the chain through known types.
  const owner = walkChain(scope, chain.slice(0, -1).split('.'), imported);
  if (owner === 'io') return IO_MEMBERS.map((i) => ({ label: i.name, kind: 'Field', doc: i.doc }));
  if (!owner) return GENERIC_MEMBERS.map((g) => ({ label: g.name, kind: 'Field', doc: g.doc, sortText: `1${g.name}` }));
  return [
    ...fields(owner),
    ...keywords(
      EXPRESSION_BUILTINS.filter((b) => b.name === '_parent' || b.name === '_io'),
      1,
    ),
  ];
}
