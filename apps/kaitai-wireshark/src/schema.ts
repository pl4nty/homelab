// Derives the dissector's field schema from .ksy specs. The glue (src/lua/glue.lua) turns it into Wireshark fields.
//
// The compiler produces the parser; this only answers what the parser can't tell the glue at load time, when
// Wireshark needs every field registered: each type's Lua class, its fields and their Wireshark types, and enums.

// biome-ignore lint/suspicious/noExplicitAny: .ksy is untyped YAML
export type Ksy = Record<string, any>;

export type Kind =
  | 'u1'
  | 'u2'
  | 'u4'
  | 'u8'
  | 's1'
  | 's2'
  | 's4'
  | 's8'
  | 'bool'
  | 'float'
  | 'double'
  | 'string'
  | 'bytes'
  | 'struct'
  | 'switch'
  | 'value';

export interface Field {
  id: string;
  kind: Kind;
  enum?: string;
  doc?: string;
}

export interface Type {
  lua: string;
  fields: Field[];
  instances: string[];
  param_ids: string[];
  repr?: string;
}

export interface Schema {
  types: Record<string, Type>;
  enums: Record<string, Record<string, string>>;
}

// kaitai-struct-compiler's class naming: snake_case to UpperCamelCase.
export function upperCamel(s: string): string {
  if (s.startsWith('_')) return `_${upperCamel(s.slice(1))}`;
  return s
    .split('_')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

const INT = /^([us])([1248])(le|be)?$/;
const BITS = /^b(\d+)(le|be)?$/;
const FLOAT = /^f([48])(le|be)?$/;

function kindOf(attr: Ksy): Kind {
  if (attr.value !== undefined) return 'value';
  const t = attr.type;
  if (t === undefined) return 'bytes';
  if (typeof t === 'object') {
    const cases = Object.values<string>(t.cases ?? {});
    return cases.length > 0 && cases.every((c) => kindOf({ type: c }) === 'struct') ? 'struct' : 'switch';
  }
  let m = INT.exec(t);
  if (m) return `${m[1]}${m[2]}` as Kind;
  m = BITS.exec(t);
  if (m) {
    const n = Number(m[1]);
    return n === 1 ? 'bool' : n <= 8 ? 'u1' : n <= 16 ? 'u2' : n <= 32 ? 'u4' : 'u8';
  }
  m = FLOAT.exec(t);
  if (m) return m[1] === '4' ? 'float' : 'double';
  if (t === 'str' || t === 'strz') return 'string';
  return 'struct';
}

function firstLine(doc: unknown): string | undefined {
  return typeof doc === 'string' ? doc.trim().split('\n')[0] : undefined;
}

interface EnumRef {
  path: string[];
  field: Field;
  ref: string;
}

// Adds a spec's types and enums to the schema, under the spec's meta.id.
function addSpec(schema: Schema, spec: Ksy, pending: EnumRef[]): void {
  const id: string = spec.meta.id;

  const visit = (type: Ksy, path: string[], lua: string) => {
    const key = path.join('.');
    for (const [name, values] of Object.entries<Ksy>(type.enums ?? {})) {
      const labels: Record<string, string> = {};
      for (const [v, label] of Object.entries(values)) {
        labels[String(Number(v))] = typeof label === 'object' ? label.id : String(label);
      }
      schema.enums[`${key}.${name}`] = labels;
    }
    const fields: Field[] = [];
    const add = (attr: Ksy, fid: string) => {
      const field: Field = { id: fid, kind: kindOf(attr) };
      const doc = firstLine(attr.doc);
      if (doc) field.doc = doc;
      if (attr.enum) pending.push({ path, field, ref: attr.enum });
      fields.push(field);
    };
    (type.seq ?? []).forEach((attr: Ksy, i: number) => {
      add(attr, attr.id ?? `_unnamed${i}`);
    });
    const instances = Object.keys(type.instances ?? {});
    for (const iid of instances) add(type.instances[iid], iid);
    const t: Type = {
      lua,
      fields,
      instances,
      param_ids: (type.params ?? []).map((p: Ksy) => p.id),
    };
    if (type['-webide-representation']) t.repr = type['-webide-representation'];
    schema.types[key] = t;
    for (const [name, sub] of Object.entries<Ksy>(type.types ?? {})) {
      visit(sub, [...path, name], `${lua}.${upperCamel(name)}`);
    }
  };
  visit(spec, [id], upperCamel(id));
}

// The schema of a spec and the specs it imports.
export function buildSchema(specs: Ksy[]): Schema {
  const schema: Schema = { types: {}, enums: {} };
  const pending: EnumRef[] = [];
  for (const spec of specs) addSpec(schema, spec, pending);
  // enum references resolve outwards from the referencing type, like the compiler's lookup; a reference into an
  // imported spec ("other::kind") resolves at the outermost level
  for (const { path, field, ref } of pending) {
    const parts = ref.split('::');
    for (let i = path.length; i >= 0; i--) {
      const key = [...path.slice(0, i), ...parts].join('.');
      if (schema.enums[key]) {
        field.enum = key;
        break;
      }
    }
  }
  return schema;
}

// Resolves a type name written in the root spec ("message", "a::b") to its schema key.
export function resolveType(schema: Schema, root: string, ref: string): string {
  const key = [root, ...ref.split('::')].join('.');
  if (schema.types[key]) return key;
  if (schema.types[ref]) return ref;
  throw new Error(`-wireshark: no type named ${ref}`);
}
