// Semantic model of a parsed .ksy spec: nested types, enums, fields and name resolution following
// the compiler's lookup rules. Works on plain JS objects (YAML `toJS()`), so it is pure.

// biome-ignore lint/suspicious/noExplicitAny: parsed YAML
type Json = any;

export interface TypeInfo {
  /** Type key (`chunk`), or meta/id for a spec root. */
  name: string;
  /** Type names from the spec root to this type; `[]` for the root. */
  path: string[];
  spec: Json;
  parent?: TypeInfo;
  children: Map<string, TypeInfo>;
  /** Spec id this type belongs to. */
  specId: string;
}

export function buildTypeTree(spec: Json, specId?: string): TypeInfo {
  const id = specId ?? (typeof spec?.meta?.id === 'string' ? spec.meta.id : '');
  const visit = (name: string, path: string[], s: Json, parent?: TypeInfo): TypeInfo => {
    const info: TypeInfo = { name, path, spec: s, parent, children: new Map(), specId: id };
    const types = s && typeof s === 'object' ? s.types : undefined;
    if (types && typeof types === 'object' && !Array.isArray(types)) {
      for (const [k, v] of Object.entries(types)) info.children.set(k, visit(k, [...path, k], v, info));
    }
    return info;
  };
  return visit(id, [], spec);
}

/** The type at a path of nested type names, or the deepest existing one. */
export function typeAt(root: TypeInfo, path: readonly string[]): TypeInfo {
  let t = root;
  for (const p of path) {
    const c = t.children.get(p);
    if (!c) break;
    t = c;
  }
  return t;
}

const ancestors = function* (t: TypeInfo) {
  for (let c: TypeInfo | undefined = t; c; c = c.parent) yield c;
};

/** Strips arguments, array suffixes and spaces: `foo :: bar(1, 2)` -> `['foo', 'bar']`. */
export function splitTypeRef(ref: string): string[] {
  return ref
    .replace(/\(.*$/s, '')
    .replace(/\[\]\s*$/, '')
    .split('::')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolves a type reference from a scope like the compiler does: the first name is looked up in
 * the scope's subtypes, the scope itself, then each parent in turn; then in imported specs (by
 * meta/id). Remaining names walk down subtypes.
 */
export function resolveType(scope: TypeInfo, ref: string, imported: readonly TypeInfo[] = []): TypeInfo | undefined {
  const parts = splitTypeRef(ref);
  if (!parts.length) return undefined;
  let found: TypeInfo | undefined;
  for (const t of ancestors(scope)) {
    found = t.children.get(parts[0]) ?? (t.name === parts[0] ? t : undefined);
    if (found) break;
  }
  found ??= imported.find((t) => t.name === parts[0]);
  for (const p of parts.slice(1)) found = found?.children.get(p);
  return found;
}

/** Type names usable from a scope without `::` (subtypes of the scope and of every ancestor). */
export function visibleTypes(scope: TypeInfo, imported: readonly TypeInfo[] = []): { name: string; type: TypeInfo }[] {
  const out = new Map<string, TypeInfo>();
  for (const t of ancestors(scope)) {
    for (const [k, v] of t.children) if (!out.has(k)) out.set(k, v);
  }
  for (const t of imported) {
    if (!out.has(t.name)) out.set(t.name, t);
    for (const [k, v] of t.children) if (!out.has(`${t.name}::${k}`)) out.set(`${t.name}::${k}`, v);
  }
  return [...out].map(([name, type]) => ({ name, type }));
}

export interface EnumRef {
  owner: TypeInfo;
  name: string;
  spec: Json;
}

function enumsOf(t: TypeInfo): Record<string, Json> {
  const e = t.spec?.enums;
  return e && typeof e === 'object' && !Array.isArray(e) ? e : {};
}

/** Resolves `name` or `type::name` the same way as types. */
export function resolveEnum(scope: TypeInfo, ref: string, imported: readonly TypeInfo[] = []): EnumRef | undefined {
  const parts = ref
    .split('::')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return undefined;
  const name = parts.pop() as string;
  let owners: TypeInfo[];
  if (parts.length) {
    const t = resolveType(scope, parts.join('::'), imported);
    owners = t ? [t] : [];
  } else {
    owners = [...ancestors(scope)];
  }
  for (const o of owners) {
    const spec = enumsOf(o)[name];
    if (spec !== undefined) return { owner: o, name, spec };
  }
  return undefined;
}

/** Enum names usable from a scope. */
export function visibleEnums(scope: TypeInfo, imported: readonly TypeInfo[] = []): { name: string; ref: EnumRef }[] {
  const out = new Map<string, EnumRef>();
  for (const t of ancestors(scope)) {
    for (const [k, v] of Object.entries(enumsOf(t))) if (!out.has(k)) out.set(k, { owner: t, name: k, spec: v });
    // Enums of sibling subtypes, qualified.
    for (const [cn, c] of t.children) {
      for (const [k, v] of Object.entries(enumsOf(c))) {
        const q = `${cn}::${k}`;
        if (!out.has(q)) out.set(q, { owner: c, name: k, spec: v });
      }
    }
  }
  for (const t of imported) {
    for (const [k, v] of Object.entries(enumsOf(t))) {
      const q = `${t.name}::${k}`;
      if (!out.has(q)) out.set(q, { owner: t, name: k, spec: v });
    }
  }
  return [...out].map(([name, ref]) => ({ name, ref }));
}

/** Labels of an enum: `[label, value]`. */
export function enumMembers(spec: Json): { id: string; value: string; doc?: string }[] {
  if (!spec || typeof spec !== 'object') return [];
  return Object.entries(spec).map(([value, v]) =>
    v && typeof v === 'object' ? { id: String((v as Json).id), value, doc: (v as Json).doc } : { id: String(v), value },
  );
}

export interface FieldInfo {
  id: string;
  kind: 'seq' | 'instance' | 'param';
  spec: Json;
  doc?: string;
}

/** seq fields, instances and params of a type. */
export function fieldsOf(t: TypeInfo): FieldInfo[] {
  const out: FieldInfo[] = [];
  const s = t.spec;
  if (!s || typeof s !== 'object') return out;
  for (const f of Array.isArray(s.params) ? s.params : []) {
    if (typeof f?.id === 'string') out.push({ id: f.id, kind: 'param', spec: f, doc: f.doc });
  }
  for (const f of Array.isArray(s.seq) ? s.seq : []) {
    if (typeof f?.id === 'string') out.push({ id: f.id, kind: 'seq', spec: f, doc: f.doc });
  }
  if (s.instances && typeof s.instances === 'object') {
    for (const [k, v] of Object.entries(s.instances))
      out.push({ id: k, kind: 'instance', spec: v, doc: (v as Json)?.doc });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Built-in types

const INT_SIZES = [1, 2, 4, 8];

export interface BuiltinType {
  name: string;
  doc: string;
}

function builtinList(): BuiltinType[] {
  const out: BuiltinType[] = [];
  for (const sign of ['u', 's']) {
    for (const n of INT_SIZES) {
      const what = `${sign === 'u' ? 'unsigned' : 'signed'} ${n * 8}-bit integer`;
      out.push({ name: `${sign}${n}`, doc: n === 1 ? what : `${what} (default endianness)` });
      if (n > 1) {
        out.push({ name: `${sign}${n}le`, doc: `${what.replace('integer', 'little-endian integer')}` });
        out.push({ name: `${sign}${n}be`, doc: `${what.replace('integer', 'big-endian integer')}` });
      }
    }
  }
  for (const n of [4, 8]) {
    const what = `${n === 4 ? 'single' : 'double'}-precision (${n * 8}-bit) IEEE 754 float`;
    out.push({ name: `f${n}`, doc: `${what} (default endianness)` });
    out.push({ name: `f${n}le`, doc: `little-endian ${what}` });
    out.push({ name: `f${n}be`, doc: `big-endian ${what}` });
  }
  out.push({ name: 'b1', doc: '1-bit integer, read as a boolean unless `enum` is set' });
  for (const n of [2, 3, 4, 5, 6, 7, 8, 12, 16, 24, 32, 64])
    out.push({ name: `b${n}`, doc: `${n}-bit unsigned integer` });
  out.push({ name: 'str', doc: 'string of `size` bytes (or `size-eos`/`terminator`) in `encoding`' });
  out.push({ name: 'strz', doc: 'null-terminated string in `encoding`' });
  return out;
}

export const BUILTIN_TYPES: readonly BuiltinType[] = builtinList();

/** One-line description of a built-in type, including any `bN`/`bNle`/`bNbe`. */
export function describeBuiltin(name: string): string | undefined {
  const known = BUILTIN_TYPES.find((b) => b.name === name);
  if (known) return known.doc;
  const m = /^b(\d+)(le|be)?$/.exec(name);
  if (m && +m[1] >= 1 && +m[1] <= 64) {
    const order = m[2] === 'le' ? 'little-endian' : m[2] === 'be' ? 'big-endian' : '';
    return `${m[1]}-bit unsigned ${order ? `${order} ` : ''}bit-sized integer`;
  }
  if (name === 'bytes') return 'byte array';
  if (name === 'bool') return 'boolean (params only)';
  if (name === 'struct') return 'any user type (params only)';
  if (name === 'io') return 'a KaitaiStream (params only)';
  if (name === 'any') return 'any type (params only)';
  return undefined;
}

export const PROCESS_VALUES = [
  { name: 'zlib', doc: 'zlib (deflate) decompression' },
  { name: 'xor(key)', doc: 'XOR with a byte or byte array key' },
  { name: 'rol(n)', doc: 'rotate each byte left by n bits' },
  { name: 'ror(n)', doc: 'rotate each byte right by n bits' },
];

export const EXPRESSION_BUILTINS = [
  { name: '_root', doc: 'the top-level object of the spec' },
  { name: '_parent', doc: 'the object that contains the current one' },
  { name: '_io', doc: 'the stream the current object is read from' },
  { name: '_index', doc: 'index of the current item of a repeated attribute' },
  { name: '_', doc: 'the current item (in `repeat-until`) or the value being validated (in `valid`)' },
  { name: '_on', doc: 'the `switch-on` value (inside `cases`)' },
  { name: '_sizeof', doc: 'size of the current type in bytes, when it is fixed' },
];

export const IO_MEMBERS = [
  { name: 'pos', doc: 'current position in the stream' },
  { name: 'size', doc: 'size of the stream in bytes' },
  { name: 'eof', doc: 'true at end of stream' },
];

/** Levenshtein distance, for "did you mean" suggestions. */
export function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = t;
    }
  }
  return prev[b.length];
}

/** Up to `n` candidates close to `name`. */
export function closeMatches(name: string, candidates: Iterable<string>, n = 3): string[] {
  const max = Math.max(2, Math.floor(name.length / 3));
  return [...new Set(candidates)]
    .map((c) => ({ c, d: editDistance(name, c) }))
    .filter((x) => x.d <= max && x.c !== name)
    .sort((x, y) => x.d - y.d || x.c.localeCompare(y.c))
    .slice(0, n)
    .map((x) => x.c);
}
