// KSY schema knowledge: which keys are allowed where, their docs, and value hints. Pure (no vscode).
import ksySchema from '../../schema/ksy_schema.json' with { type: 'json' };

// biome-ignore lint/suspicious/noExplicitAny: JSON schema nodes
type Json = any;

const SCHEMA: Json = ksySchema;
const DEFS = SCHEMA.definitions;

/** Kind of YAML mapping (or scalar slot) at a path in a .ksy document. */
export type KsyContext =
  | 'root'
  | 'type'
  | 'meta'
  | 'xref'
  | 'imports'
  | 'seq'
  | 'attribute'
  | 'instances'
  | 'instance'
  | 'types'
  | 'enums'
  | 'enum'
  | 'enumValue'
  | 'params'
  | 'param'
  | 'switch'
  | 'cases'
  | 'valid'
  | 'scalar'
  | 'unknown';

export interface PathContext {
  ctx: KsyContext;
  /** Names of nested types from the root to the type the path is in (`[]` for the root type). */
  typePath: string[];
  /** For `enum` / `enumValue`: the enum name. */
  enumName?: string;
  /** The key of the last mapping entry, when the path ends in a scalar slot. */
  key?: string;
  /** Context of the mapping the final key belongs to, when the path ends in a scalar slot. */
  parentCtx?: KsyContext;
}

const TYPE_KEYS = {
  meta: 'meta',
  seq: 'seq',
  instances: 'instances',
  types: 'types',
  enums: 'enums',
  params: 'params',
} as const;
const ATTRIBUTE_KEYS = { type: 'switch', valid: 'valid' } as const;

/** Keys of each mapping context that open another context; its other keys hold scalars. */
const NESTED: Partial<Record<KsyContext, Record<string, KsyContext>>> = {
  root: TYPE_KEYS,
  type: TYPE_KEYS,
  meta: { xref: 'xref', imports: 'imports' },
  attribute: ATTRIBUTE_KEYS,
  instance: ATTRIBUTE_KEYS,
  switch: { cases: 'cases' },
  cases: {},
  valid: {},
  xref: {},
  imports: {},
  enumValue: {},
  param: {},
};

const isIndex = (s: string) => s === '*' || /^\d+$/.test(s);

function childContext(ctx: KsyContext, seg: string): KsyContext {
  switch (ctx) {
    case 'seq':
      return isIndex(seg) ? 'attribute' : 'unknown';
    case 'params':
      return isIndex(seg) ? 'param' : 'unknown';
    case 'instances':
      return 'instance';
    case 'types':
      return 'type';
    case 'enums':
      return 'enum';
    case 'enum':
      return 'enumValue';
    default: {
      const nested = NESTED[ctx];
      if (!nested) return 'unknown';
      return Object.hasOwn(nested, seg) ? nested[seg] : 'scalar';
    }
  }
}

/** Classifies a YAML path such as `['types', 'chunk', 'seq', '0', 'type']`. `*` stands for any list index. */
export function classifyPath(path: readonly string[]): PathContext {
  let ctx: KsyContext = 'root';
  let parentCtx: KsyContext | undefined;
  let enumName: string | undefined;
  const typePath: string[] = [];
  for (const seg of path) {
    if (ctx === 'types') typePath.push(seg);
    else if (ctx === 'enums') enumName = seg;
    parentCtx = ctx;
    ctx = childContext(ctx, seg);
  }
  return { ctx, typePath, enumName, key: path.at(-1), parentCtx };
}

/** Keys whose values are Kaitai expressions. */
const EXPRESSION_KEYS = new Set([
  'if',
  'size',
  'repeat-expr',
  'repeat-until',
  'value',
  'pos',
  'switch-on',
  'io',
  'eq',
  'min',
  'max',
  'expr',
  'to-string',
]);

/** The value at this path names a type (`type: foo`, or a `cases` value). */
export const isTypeSlot = (c: PathContext) =>
  c.parentCtx === 'cases' ||
  (c.key === 'type' && (c.parentCtx === 'attribute' || c.parentCtx === 'instance' || c.parentCtx === 'param'));

/** The value at this path is a Kaitai expression. */
export const isExpressionSlot = (c: PathContext) =>
  c.key !== undefined && (EXPRESSION_KEYS.has(c.key) || c.parentCtx === 'valid');

function resolveRef(node: Json): Json {
  let n = node;
  for (let i = 0; i < 10 && n?.$ref; i++) {
    const { $ref, ...own } = n;
    n = { ...DEFS[String($ref).replace('#/definitions/', '')], ...own };
  }
  return n;
}

/** All object properties of a schema node, merging anyOf/allOf variants. */
function propertiesOf(node: Json): Record<string, Json> {
  const n = resolveRef(node);
  const out: Record<string, Json> = { ...n?.properties };
  for (const variant of [...(n?.anyOf ?? []), ...(n?.allOf ?? [])]) {
    for (const [k, v] of Object.entries(propertiesOf(variant))) out[k] ??= v;
  }
  return out;
}

function descriptionOf(node: Json): string | undefined {
  const r = resolveRef(node);
  if (typeof r?.description === 'string') return r.description;
  for (const v of r?.anyOf ?? []) {
    const d = descriptionOf(v);
    if (d) return d;
  }
  return undefined;
}

/** Literal values allowed by a schema node (enum lists, booleans). */
function valuesOf(node: Json): string[] {
  const r = resolveRef(node);
  if (!r) return [];
  return [
    ...new Set<string>([
      ...(r.enum ?? []).map(String),
      ...(r.type === 'boolean' ? ['true', 'false'] : []),
      ...(r.anyOf ?? []).flatMap(valuesOf),
    ]),
  ];
}

function schemaForContext(ctx: KsyContext): Record<string, Json> {
  switch (ctx) {
    case 'root':
      return SCHEMA.properties;
    case 'type':
      return propertiesOf(DEFS.TypeSpec);
    case 'meta':
      return propertiesOf(DEFS.MetaSpec);
    case 'xref':
      return propertiesOf(DEFS.MetaSpec.properties.xref);
    case 'attribute': {
      const { pos: _p, io: _i, value: _v, ...rest } = propertiesOf(DEFS.Attribute);
      return rest;
    }
    case 'instance': {
      const { id: _id, ...rest } = propertiesOf(DEFS.Attribute);
      return rest;
    }
    case 'param':
      return propertiesOf(DEFS.ParamSpec);
    case 'switch':
      return {
        'switch-on': { description: 'expression whose value selects the type from `cases`' },
        cases: { description: 'map of `switch-on` values (expressions) to types; `_` is the default case' },
      };
    case 'valid':
      return propertiesOf(DEFS.ValidationSpec);
    case 'enumValue':
      return propertiesOf(DEFS.EnumValueSpec);
    default:
      return {};
  }
}

export interface KeyInfo {
  key: string;
  doc?: string;
  /** Literal values the key accepts (enum values or booleans). */
  values: string[];
}

/** Where the schema documents a key on its definition rather than at each use. */
const DOC_FALLBACK: Record<string, Json> = {
  doc: DEFS.Doc,
  'doc-ref': DEFS.DocRef,
  'to-string': DEFS.ToString,
  encoding: DEFS.CharacterEncoding,
};

const keysCache = new Map<KsyContext, KeyInfo[]>();

/** Keys allowed in the mapping of the given context. */
export function keysFor(ctx: KsyContext): KeyInfo[] {
  let keys = keysCache.get(ctx);
  if (!keys) {
    keys = Object.entries(schemaForContext(ctx)).map(([key, node]) => ({
      key,
      doc: descriptionOf(node) ?? descriptionOf(DOC_FALLBACK[key]),
      values: valuesOf(node),
    }));
    keysCache.set(ctx, keys);
  }
  return keys;
}

/** Documentation of one key in a context. */
export function keyInfo(ctx: KsyContext, key: string): KeyInfo | undefined {
  return keysFor(ctx).find((k) => k.key === key);
}

/** Canonical character encodings known to the compiler. */
export const ENCODINGS: readonly string[] = DEFS.CharacterEncoding.enum;
