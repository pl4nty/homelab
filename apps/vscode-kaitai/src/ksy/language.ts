// Definition, hover and diagnostic placement for .ksy documents, on top of the YAML AST and the
// semantic model. Pure (no vscode); the provider layer converts offsets to positions.
import {
  BUILTIN_TYPES,
  closeMatches,
  describeBuiltin,
  type EnumRef,
  EXPRESSION_BUILTINS,
  enumMembers,
  type FieldInfo,
  fieldsOf,
  resolveEnum,
  resolveType,
  rootOf,
  type TypeInfo,
  typeAt,
  visibleEnums,
  visibleTypes,
  walkChain,
} from './model.ts';
import { classifyPath, isExpressionSlot, isTypeSlot, type KsyContext, keyInfo, type PathContext } from './schema.ts';
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

const stripSlashes = (s: string) => s.replace(/^\/+/, '');
const baseName = (s: string) => s.slice(s.lastIndexOf('/') + 1);

/** Whether a compile error is inside an imported spec rather than the document itself. */
export function isImportedError(err: KsyErrorLike, ownId: string | undefined) {
  return !!err.file && err.file !== ownId;
}

/** YAML path to report a compile error at. Errors inside imports go on the meta/imports entry. */
export function diagnosticTargetPath(parsed: ParsedKsy, err: KsyErrorLike, ownId: string | undefined): string[] {
  if (!err.file || !isImportedError(err, ownId)) return err.path?.length ? [...err.path] : ['meta', 'id'];
  const file = stripSlashes(err.file);
  const names = importEntries(parsed).map((e) => stripSlashes(e.name));
  let i = names.indexOf(file);
  if (i < 0) i = names.findIndex((n) => baseName(n) === baseName(file));
  if (i >= 0) return ['meta', 'imports', String(i)];
  return names.length ? ['meta', 'imports'] : ['meta', 'id'];
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
): string[] {
  const scope = typeAt(parsed.root, classifyPath(path).typePath);
  const last = name.split('::').at(-1) ?? name;
  const names =
    what === 'type'
      ? [...visibleTypes(scope, imported).map((t) => t.name), ...BUILTIN_TYPES.map((b) => b.name)]
      : visibleEnums(scope, imported).map((e) => e.name);
  return [...new Set([...closeMatches(name, names), ...(name !== last ? closeMatches(last, names) : [])])];
}

// ---------------------------------------------------------------------------------------------
// What is under the cursor

type Ref =
  | { kind: 'type'; type?: TypeInfo; name: string; builtin?: string }
  | { kind: 'enum'; ref?: EnumRef; name: string; label?: string }
  | { kind: 'field'; owner: TypeInfo; field: FieldInfo }
  | { kind: 'special'; name: string; type?: TypeInfo }
  | { kind: 'import'; name: string };

interface Located {
  n: NodeAt;
  c: PathContext;
  ref?: Ref;
  /** Source range of the word the ref was read from. */
  wordRange?: OffsetRange;
}

/** The identifier at `pos` in a `a :: b :: c` reference, with the parts up to and including it. */
function partsUpTo(src: string, pos: number): { parts: string[]; start: number; end: number } | undefined {
  const parts: string[] = [];
  for (const m of src.matchAll(/[A-Za-z_]\w*/g)) {
    const end = m.index + m[0].length;
    parts.push(m[0]);
    if (pos >= m.index && pos <= end) return { parts, start: m.index, end };
    if (src.slice(end).trimStart().startsWith('(')) break; // arguments follow
  }
  return undefined;
}

/** An enum if `name` is one, otherwise the type of that name (`type::enum::label` prefixes). */
function enumOrType(scope: TypeInfo, name: string, imported: readonly TypeInfo[]): Ref {
  const ref = resolveEnum(scope, name, imported);
  return ref ? { kind: 'enum', ref, name } : { kind: 'type', type: resolveType(scope, name, imported), name };
}

/** The reference under the cursor inside an expression. */
function expressionRef(
  src: string,
  start: number,
  end: number,
  scope: TypeInfo,
  imported: readonly TypeInfo[],
): Ref | undefined {
  const word = src.slice(start, end);
  const head = (/((?:[A-Za-z_]\w*\s*(?:\.|::)\s*)*)$/.exec(src.slice(0, start))?.[1] ?? '').replace(/\s+/g, '');
  const enumFollows = src.slice(end).trimStart().startsWith('::');
  if (head.endsWith('::')) {
    const enumPath = head.slice(0, -2);
    // `type::enum::label`: in the middle, or on the label.
    if (enumFollows) return enumOrType(scope, `${enumPath}::${word}`, imported);
    return { kind: 'enum', ref: resolveEnum(scope, enumPath, imported), name: enumPath, label: word };
  }
  if (enumFollows) return enumOrType(scope, word, imported);
  const owner = walkChain(scope, head ? head.slice(0, -1).split('.') : [], imported);
  if (owner === 'io' || owner === undefined) return undefined;
  if (word === '_root') return { kind: 'special', name: word, type: rootOf(owner) };
  if (word === '_parent') return { kind: 'special', name: word, type: owner.parent };
  if (word.startsWith('_')) return { kind: 'special', name: word };
  const field = fieldsOf(owner).find((f) => f.id === word);
  return field && { kind: 'field', owner, field };
}

function locate(parsed: ParsedKsy, text: string, offset: number, imported: readonly TypeInfo[]): Located | undefined {
  const n = nodeAt(parsed, offset);
  if (!n) return undefined;
  const c = classifyPath(n.path);
  const loc: Located = { n, c };
  if (!n.scalar) return loc;
  const scope = typeAt(parsed.root, c.typePath);
  const base = n.scalar.range.start;
  const src = text.slice(base, n.scalar.range.end);
  const pos = offset - base;
  const setWord = (w: { start: number; end: number }) => {
    loc.wordRange = { start: base + w.start, end: base + w.end };
  };

  if (!n.onKey && c.parentCtx === 'imports') {
    loc.ref = { kind: 'import', name: n.scalar.value };
  } else if (!n.onKey && (isTypeSlot(c) || (c.key === 'enum' && c.parentCtx !== 'meta'))) {
    const up = partsUpTo(src, pos);
    if (!up) return loc;
    setWord(up);
    const name = up.parts.join('::');
    // In `enum: type::name`, only the last part is the enum.
    if (c.key === 'enum' && !isTypeSlot(c) && !src.slice(up.end).includes('::')) {
      loc.ref = { kind: 'enum', ref: resolveEnum(scope, name, imported), name };
    } else {
      const builtin = up.parts.length === 1 && isTypeSlot(c) ? describeBuiltin(name) : undefined;
      loc.ref = { kind: 'type', type: builtin ? undefined : resolveType(scope, name, imported), name, builtin };
    }
  } else if (n.onKey ? c.parentCtx === 'cases' : isExpressionSlot(c)) {
    // Word at the cursor.
    const start = pos - (/\w*$/.exec(src.slice(0, pos))?.[0].length ?? 0);
    const end = pos + (/^\w*/.exec(src.slice(pos))?.[0].length ?? 0);
    if (!/^[A-Za-z_]/.test(src.slice(start, end))) return loc;
    setWord({ start, end });
    loc.ref = expressionRef(src, start, end, scope, imported);
  }
  return loc;
}

/** What a name refers to inside the type `type`: the type itself, an enum (member) or a field. */
export interface SymbolRef {
  type: TypeInfo;
  enumName?: string;
  label?: string;
  field?: string;
}

/** Range of a symbol's name in the spec that defines it. */
export function symbolRange(parsed: ParsedKsy, s: SymbolRef): OffsetRange | undefined {
  if (s.field) return fieldRange(parsed, s.type.path, s.field);
  if (s.enumName) return enumRange(parsed, s.type.path, s.enumName, s.label);
  return typeKeyRange(parsed, s.type.path);
}

export type DefinitionTarget =
  | { kind: 'local'; range: OffsetRange }
  /** An entry of meta/imports, as written. */
  | { kind: 'import'; name: string }
  /** A symbol of an imported spec; `symbolRange` locates it in that spec. */
  | ({ kind: 'imported' } & SymbolRef);

function symbolOf(ref: Ref): SymbolRef | undefined {
  switch (ref.kind) {
    case 'type':
    case 'special':
      return ref.type && { type: ref.type };
    case 'enum':
      return ref.ref && { type: ref.ref.owner, enumName: ref.ref.name, label: ref.label };
    case 'field':
      return { type: ref.owner, field: ref.field.id };
    case 'import':
      return undefined;
  }
}

/** Where the name at `offset` is defined. */
export function definitionTarget(
  parsed: ParsedKsy,
  text: string,
  offset: number,
  imported: readonly TypeInfo[] = [],
): DefinitionTarget | undefined {
  const ref = locate(parsed, text, offset, imported)?.ref;
  if (!ref) return undefined;
  if (ref.kind === 'import') return ref;
  const s = symbolOf(ref);
  if (!s) return undefined;
  if (rootOf(s.type) !== parsed.root) return { kind: 'imported', ...s };
  const range = symbolRange(parsed, s);
  return range && { kind: 'local', range };
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

function describeType(parsed: ParsedKsy, t: TypeInfo) {
  const local = rootOf(t) === parsed.root;
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

function describeEnum(parsed: ParsedKsy, e: EnumRef, label?: string) {
  const members = enumMembers(e.spec);
  const local = rootOf(e.owner) === parsed.root;
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
  const scalar = loc?.n.scalar;
  if (!loc || !scalar) return undefined;
  const markdown = loc.ref ? refDoc(parsed, loc.ref) : keyOrNameDoc(parsed, loc.n, loc.c);
  return markdown ? { markdown, range: loc.wordRange ?? scalar.range } : undefined;
}

function refDoc(parsed: ParsedKsy, ref: Ref): string | undefined {
  switch (ref.kind) {
    case 'type':
      if (ref.builtin) return `\`${ref.name}\`: ${ref.builtin}`;
      return ref.type ? describeType(parsed, ref.type) : `Unknown type \`${ref.name}\``;
    case 'enum':
      return ref.ref && describeEnum(parsed, ref.ref, ref.label);
    case 'field': {
      const f = ref.field;
      const type = typeof f.spec?.type === 'string' ? `: ${f.spec.type}` : '';
      const doc = typeof f.doc === 'string' ? `\n\n${f.doc}` : '';
      return `**${f.kind === 'seq' ? 'field' : f.kind}** \`${f.id}\`${type}${doc}`;
    }
    case 'special': {
      const b = EXPRESSION_BUILTINS.find((x) => x.name === ref.name);
      return b && `\`${b.name}\`: ${b.doc}`;
    }
    case 'import': {
      const abs = ref.name.startsWith('/');
      return `Import \`${ref.name.slice(abs ? 1 : 0)}.ksy\` (${abs ? 'absolute' : 'relative'})`;
    }
  }
}

/** Hover for a key (its schema doc, or the type/enum it names) or for a plain value (its key's doc). */
function keyOrNameDoc(parsed: ParsedKsy, n: NodeAt, c: PathContext): string | undefined {
  if (n.onKey && c.parentCtx === 'types') return describeType(parsed, typeAt(parsed.root, c.typePath));
  if (n.onKey && c.parentCtx === 'enums' && c.enumName) {
    const e = resolveEnum(typeAt(parsed.root, c.typePath), c.enumName);
    return e && describeEnum(parsed, e);
  }
  return c.key && keyDoc(c.parentCtx, c.key);
}
