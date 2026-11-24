// Definition, hover and diagnostic placement for .ksy documents, on top of the YAML AST and the
// semantic model. Pure (no vscode); the provider layer converts offsets to positions.
import {
  BUILTIN_TYPES,
  buildTypeTree,
  closeMatches,
  describeBuiltin,
  type EnumRef,
  EXPRESSION_BUILTINS,
  enumMembers,
  type FieldInfo,
  fieldsOf,
  resolveEnum,
  resolveType,
  type TypeInfo,
  typeAt,
  visibleEnums,
  visibleTypes,
} from './model.ts';
import { classifyPath, EXPRESSION_KEYS, type KsyContext, keyInfo, type PathContext } from './schema.ts';
import {
  enumRange,
  fieldRange,
  importEntries,
  type NodeAt,
  nodeAt,
  type OffsetRange,
  type ParsedKsy,
  typeKeyRange,
} from './yamlAst.ts';

export interface KsyErrorLike {
  message: string;
  path?: readonly string[];
  file?: string;
}

const baseName = (s: string) => s.replace(/^\/+/, '').split('/').pop() ?? s;

/** YAML path to report a compile error at. Errors inside imports go on the meta/imports entry. */
export function diagnosticTargetPath(parsed: ParsedKsy, err: KsyErrorLike, ownId: string | undefined): string[] {
  if (err.file && err.file !== ownId) {
    const entries = importEntries(parsed);
    const i = entries.findIndex((e) => e.name.replace(/^\/+/, '') === err.file?.replace(/^\/+/, ''));
    const j = i >= 0 ? i : entries.findIndex((e) => baseName(e.name) === baseName(err.file as string));
    if (j >= 0) return ['meta', 'imports', String(j)];
    return entries.length ? ['meta', 'imports'] : ['meta', 'id'];
  }
  return err.path?.length ? [...err.path] : ['meta', 'id'];
}

/** Whether a compile error is inside an imported spec rather than the document itself. */
export function isImportedError(err: KsyErrorLike, ownId: string | undefined) {
  return !!err.file && err.file !== ownId;
}

/** `unable to find type 'foo'` -> `{ what: 'type', name: 'foo' }`. */
export function unresolvedName(message: string): { what: 'type' | 'enum'; name: string } | undefined {
  const m = /unable to find (type|enum) '([^']+)'/.exec(message);
  return m ? { what: m[1] as 'type' | 'enum', name: m[2] } : undefined;
}

/** "Did you mean" candidates for an unresolved type or enum, as seen from the error's scope. */
export function suggestionsFor(
  parsed: ParsedKsy,
  path: readonly string[],
  what: 'type' | 'enum',
  name: string,
  imported: readonly TypeInfo[] = [],
) {
  const root = rootOf(parsed);
  const scope = typeAt(root, classifyPath(path).typePath);
  const last = name.split('::').pop() ?? name;
  const names =
    what === 'type'
      ? [...visibleTypes(scope, imported).map((t) => t.name), ...BUILTIN_TYPES.map((b) => b.name)]
      : visibleEnums(scope, imported).map((e) => e.name);
  return closeMatches(name, names)
    .concat(name !== last ? closeMatches(last, names) : [])
    .filter((v, i, a) => a.indexOf(v) === i);
}

export function rootOf(parsed: ParsedKsy): TypeInfo {
  return buildTypeTree(parsed.js && typeof parsed.js === 'object' ? parsed.js : {});
}

// ---------------------------------------------------------------------------------------------
// What is under the cursor

type Ref =
  | { kind: 'type'; type?: TypeInfo; name: string; builtin?: string }
  | { kind: 'enum'; ref?: EnumRef; name: string; label?: string }
  | { kind: 'field'; owner: TypeInfo; field: FieldInfo }
  | { kind: 'special'; name: string; type?: TypeInfo }
  | { kind: 'import'; name: string; mode: 'rel' | 'abs' };

interface Located {
  n: NodeAt;
  c: PathContext;
  scope: TypeInfo;
  root: TypeInfo;
  ref?: Ref;
  /** Source range of the word the ref was read from. */
  wordRange?: OffsetRange;
}

const isTypeSlot = (c: PathContext, n: NodeAt) =>
  !n.onKey &&
  ((c.key === 'type' && (c.parentCtx === 'attribute' || c.parentCtx === 'instance' || c.parentCtx === 'param')) ||
    c.parentCtx === 'cases');

const isExpressionSlot = (c: PathContext, n: NodeAt) =>
  (n.onKey && c.parentCtx === 'cases') ||
  (!n.onKey &&
    !!c.key &&
    (EXPRESSION_KEYS.has(c.key) || c.parentCtx === 'valid' || (c.parentCtx === 'switch' && c.key === 'switch-on')) &&
    c.parentCtx !== 'meta');

/** Splits `a :: b :: c` keeping offsets; returns the parts up to the one at `pos`. */
function partsUpTo(src: string, pos: number): { parts: string[]; start: number; end: number } | undefined {
  const re = /[A-Za-z_][\w]*/g;
  const parts: string[] = [];
  for (let m = re.exec(src); m; m = re.exec(src)) {
    parts.push(m[0]);
    if (pos >= m.index && pos <= m.index + m[0].length) return { parts, start: m.index, end: m.index + m[0].length };
    if (
      src
        .slice(m.index + m[0].length)
        .trimStart()
        .startsWith('(')
    )
      break; // arguments follow
  }
  return undefined;
}

function walkChain(
  scope: TypeInfo,
  root: TypeInfo,
  chain: string[],
  imported: readonly TypeInfo[],
): TypeInfo | 'io' | undefined {
  let cur: TypeInfo | 'io' | undefined = scope;
  for (const p of chain) {
    if (cur === undefined || cur === 'io') return undefined;
    if (p === '_root') cur = root;
    else if (p === '_parent') cur = cur.parent;
    else if (p === '_io') cur = 'io';
    else {
      const f: FieldInfo | undefined = fieldsOf(cur).find((x) => x.id === p);
      cur = typeof f?.spec?.type === 'string' ? resolveType(cur, f.spec.type, imported) : undefined;
    }
  }
  return cur;
}

function locate(parsed: ParsedKsy, text: string, offset: number, imported: readonly TypeInfo[]): Located | undefined {
  const n = nodeAt(parsed, offset);
  if (!n) return undefined;
  const c = classifyPath(n.path);
  const root = rootOf(parsed);
  const scope = typeAt(root, c.typePath);
  const loc: Located = { n, c, scope, root };
  if (!n.scalar) return loc;
  const src = text.slice(n.scalar.range.start, n.scalar.range.end);
  const pos = offset - n.scalar.range.start;

  if (!n.onKey && n.path.length === 3 && n.path[0] === 'meta' && n.path[1] === 'imports') {
    const name = n.scalar.value;
    loc.ref = name.startsWith('/')
      ? { kind: 'import', name: name.slice(1), mode: 'abs' }
      : { kind: 'import', name, mode: 'rel' };
    loc.wordRange = n.scalar.range;
    return loc;
  }
  if (isTypeSlot(c, n)) {
    const up = partsUpTo(src, pos);
    if (!up) return loc;
    const name = up.parts.join('::');
    loc.wordRange = { start: n.scalar.range.start + up.start, end: n.scalar.range.start + up.end };
    const builtin = up.parts.length === 1 ? describeBuiltin(name) : undefined;
    const type = builtin ? undefined : resolveType(scope, name, imported);
    loc.ref = { kind: 'type', type, name, builtin };
    return loc;
  }
  if (!n.onKey && c.key === 'enum' && c.parentCtx !== 'meta') {
    const up = partsUpTo(src, pos);
    if (!up) return loc;
    const all = n.scalar.value.split('::').map((s) => s.trim());
    loc.wordRange = { start: n.scalar.range.start + up.start, end: n.scalar.range.start + up.end };
    if (up.parts.length === all.length)
      loc.ref = { kind: 'enum', ref: resolveEnum(scope, all.join('::'), imported), name: all.join('::') };
    else {
      const name = up.parts.join('::');
      loc.ref = { kind: 'type', type: resolveType(scope, name, imported), name };
    }
    return loc;
  }
  if (isExpressionSlot(c, n)) {
    // Word at the cursor and the chain before it.
    let s = pos;
    let e = pos;
    while (s > 0 && /\w/.test(src[s - 1])) s--;
    while (e < src.length && /\w/.test(src[e])) e++;
    const word = src.slice(s, e);
    if (!/^[A-Za-z_]\w*$/.test(word)) return loc;
    loc.wordRange = { start: n.scalar.range.start + s, end: n.scalar.range.start + e };
    const head = /((?:[A-Za-z_]\w*\s*(?:\.|::)\s*)*)$/.exec(src.slice(0, s))?.[1] ?? '';
    const after = src.slice(e).trimStart();
    if (head.trimEnd().endsWith('::')) {
      const enumPath = head.replace(/\s+/g, '').replace(/::$/, '');
      if (after.startsWith('::')) {
        // middle of `type::enum::label`
        const full = `${enumPath}::${word}`;
        const ref = resolveEnum(scope, full, imported);
        loc.ref = ref
          ? { kind: 'enum', ref, name: full }
          : { kind: 'type', type: resolveType(scope, full, imported), name: full };
      } else {
        loc.ref = { kind: 'enum', ref: resolveEnum(scope, enumPath, imported), name: enumPath, label: word };
      }
      return loc;
    }
    if (after.startsWith('::')) {
      const ref = resolveEnum(scope, word, imported);
      loc.ref = ref
        ? { kind: 'enum', ref, name: word }
        : { kind: 'type', type: resolveType(scope, word, imported), name: word };
      return loc;
    }
    const chain = head.trim() ? head.replace(/\s+/g, '').replace(/\.$/, '').split('.') : [];
    const owner = walkChain(scope, root, chain, imported);
    if (owner === 'io' || owner === undefined) return loc;
    if (word === '_root') loc.ref = { kind: 'special', name: word, type: root };
    else if (word === '_parent') loc.ref = { kind: 'special', name: word, type: owner.parent };
    else if (word.startsWith('_')) loc.ref = { kind: 'special', name: word };
    else {
      const field = fieldsOf(owner).find((f) => f.id === word);
      if (field) loc.ref = { kind: 'field', owner, field };
    }
  }
  return loc;
}

export type DefinitionTarget =
  | { kind: 'local'; range: OffsetRange }
  | { kind: 'import'; name: string; mode: 'rel' | 'abs' }
  /** A definition inside an imported spec, identified by its meta/id. */
  | { kind: 'imported'; specId: string; typePath: string[]; enumName?: string; label?: string; field?: string };

function targetFor(
  parsed: ParsedKsy,
  root: TypeInfo,
  t: TypeInfo,
  what: { enumName?: string; label?: string; field?: string },
): DefinitionTarget | undefined {
  if (rootOfType(t) !== root) {
    return { kind: 'imported', specId: t.specId, typePath: t.path, ...what };
  }
  const range = what.field
    ? fieldRange(parsed, t.path, what.field)
    : what.enumName
      ? enumRange(parsed, t.path, what.enumName, what.label)
      : typeKeyRange(parsed, t.path);
  return range && { kind: 'local', range };
}

function rootOfType(t: TypeInfo) {
  let r = t;
  while (r.parent) r = r.parent;
  return r;
}

/** Where the name at `offset` is defined. */
export function definitionTarget(
  parsed: ParsedKsy,
  text: string,
  offset: number,
  imported: readonly TypeInfo[] = [],
): DefinitionTarget | undefined {
  const loc = locate(parsed, text, offset, imported);
  const ref = loc?.ref;
  if (!loc || !ref) return undefined;
  switch (ref.kind) {
    case 'import':
      return { kind: 'import', name: ref.name, mode: ref.mode };
    case 'type':
      return ref.type ? targetFor(parsed, loc.root, ref.type, {}) : undefined;
    case 'enum':
      return ref.ref
        ? targetFor(parsed, loc.root, ref.ref.owner, { enumName: ref.ref.name, label: ref.label })
        : undefined;
    case 'field':
      return targetFor(parsed, loc.root, ref.owner, { field: ref.field.id });
    case 'special':
      return ref.type ? targetFor(parsed, loc.root, ref.type, {}) : undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Hover

export interface HoverInfo {
  markdown: string;
  range?: OffsetRange;
}

const typeLabel = (t: TypeInfo) => (t.path.length ? `/types/${t.path.join('/types/')}` : `${t.specId} (root type)`);

function lineOf(parsed: ParsedKsy, range: OffsetRange | undefined) {
  return range ? parsed.lines.linePos(range.start).line : undefined;
}

function describeType(parsed: ParsedKsy, root: TypeInfo, t: TypeInfo) {
  const local = rootOfType(t) === root;
  const line = local ? lineOf(parsed, typeKeyRange(parsed, t.path)) : undefined;
  const where = local
    ? `\`${typeLabel(t)}\`${line ? ` (line ${line})` : ''}`
    : `\`${typeLabel(t)}\` in \`${t.specId}\``;
  const doc = typeof t.spec?.doc === 'string' ? `\n\n${t.spec.doc}` : '';
  const fields = fieldsOf(t)
    .slice(0, 12)
    .map((f) => `- \`${f.id}\`${typeof f.spec?.type === 'string' ? `: ${f.spec.type}` : ''}`)
    .join('\n');
  return `**type** \`${t.name}\` — defined at ${where}${doc}${fields ? `\n\n${fields}` : ''}`;
}

function describeEnum(parsed: ParsedKsy, root: TypeInfo, e: EnumRef, label?: string) {
  const members = enumMembers(e.spec);
  const local = rootOfType(e.owner) === root;
  const line = local ? lineOf(parsed, enumRange(parsed, e.owner.path, e.name)) : undefined;
  const owner = e.owner.path.length ? `/types/${e.owner.path.join('/types/')}` : '';
  const where = `\`${owner}/enums/${e.name}\`${local ? (line ? ` (line ${line})` : '') : ` in \`${e.owner.specId}\``}`;
  if (label !== undefined) {
    const m = members.find((x) => x.id === label);
    return `**enum value** \`${e.name}::${label}\`${m ? ` = ${m.value}` : ''} — ${where}${m?.doc ? `\n\n${m.doc}` : ''}`;
  }
  const list = members
    .slice(0, 24)
    .map((m) => `- ${m.value}: \`${m.id}\`${m.doc ? ` — ${String(m.doc).split('\n')[0]}` : ''}`)
    .join('\n');
  return `**enum** \`${e.name}\` — defined at ${where}${list ? `\n\n${list}` : ''}${members.length > 24 ? '\n- …' : ''}`;
}

function keyDoc(ctx: KsyContext | undefined, key: string) {
  if (!ctx) return undefined;
  const info = keyInfo(ctx, key);
  return info?.doc ? `**${key}**\n\n${info.doc}` : undefined;
}

export function hoverInfo(
  parsed: ParsedKsy,
  text: string,
  offset: number,
  imported: readonly TypeInfo[] = [],
): HoverInfo | undefined {
  const loc = locate(parsed, text, offset, imported);
  if (!loc?.n.scalar) return undefined;
  const { n, c, root, ref } = loc;
  const range = loc.wordRange ?? n.scalar?.range;
  if (ref) {
    switch (ref.kind) {
      case 'type':
        if (ref.builtin) return { markdown: `\`${ref.name}\`: ${ref.builtin}`, range };
        return ref.type
          ? { markdown: describeType(parsed, root, ref.type), range }
          : { markdown: `Unknown type \`${ref.name}\``, range };
      case 'enum':
        return ref.ref ? { markdown: describeEnum(parsed, root, ref.ref, ref.label), range } : undefined;
      case 'field': {
        const f = ref.field;
        const type = typeof f.spec?.type === 'string' ? `: ${f.spec.type}` : '';
        const doc = typeof f.doc === 'string' ? `\n\n${f.doc}` : '';
        return {
          markdown: `**${f.kind === 'instance' ? 'instance' : f.kind === 'param' ? 'param' : 'field'}** \`${f.id}\`${type}${doc}`,
          range,
        };
      }
      case 'special': {
        const b = EXPRESSION_BUILTINS.find((x) => x.name === ref.name);
        return b ? { markdown: `\`${b.name}\`: ${b.doc}`, range } : undefined;
      }
      case 'import':
        return { markdown: `Import \`${ref.name}.ksy\` (${ref.mode === 'abs' ? 'absolute' : 'relative'})`, range };
    }
  }
  if (n.onKey) {
    const key = n.scalar?.value ?? '';
    // Names in types/enums maps.
    if (c.parentCtx === 'types') {
      const t = typeAt(root, c.typePath);
      return { markdown: describeType(parsed, root, t), range };
    }
    if (c.parentCtx === 'enums' && c.enumName) {
      const e = resolveEnum(typeAt(root, c.typePath), c.enumName);
      return e ? { markdown: describeEnum(parsed, root, e), range } : undefined;
    }
    const doc = keyDoc(c.parentCtx, key);
    return doc ? { markdown: doc, range } : undefined;
  }
  // A plain value: document its key.
  const doc = c.key ? keyDoc(c.parentCtx, c.key) : undefined;
  return doc ? { markdown: doc, range } : undefined;
}
