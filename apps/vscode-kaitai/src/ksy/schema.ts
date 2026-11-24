// KSY schema knowledge: which keys are allowed where, their docs, and value hints. Pure (no vscode).
import { KSY_SCHEMA } from './schemaData.ts';

// biome-ignore lint/suspicious/noExplicitAny: JSON schema nodes
type Json = any;

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

const isIndex = (s: string) => s === '*' || /^\d+$/.test(s);

/** Classifies a YAML path such as `['types', 'chunk', 'seq', '0', 'type']`. `*` stands for any list index. */
export function classifyPath(path: readonly string[]): PathContext {
  let ctx: KsyContext = 'root';
  const typePath: string[] = [];
  let enumName: string | undefined;
  let key: string | undefined;
  let parentCtx: KsyContext | undefined;
  for (const seg of path) {
    parentCtx = ctx;
    key = seg;
    switch (ctx) {
      case 'root':
      case 'type':
        ctx =
          seg === 'meta'
            ? 'meta'
            : seg === 'seq'
              ? 'seq'
              : seg === 'instances'
                ? 'instances'
                : seg === 'types'
                  ? 'types'
                  : seg === 'enums'
                    ? 'enums'
                    : seg === 'params'
                      ? 'params'
                      : 'scalar';
        break;
      case 'meta':
        ctx = seg === 'xref' ? 'xref' : seg === 'imports' ? 'imports' : 'scalar';
        break;
      case 'seq':
        ctx = isIndex(seg) ? 'attribute' : 'unknown';
        break;
      case 'instances':
        ctx = 'instance';
        break;
      case 'types':
        typePath.push(seg);
        ctx = 'type';
        break;
      case 'enums':
        enumName = seg;
        ctx = 'enum';
        break;
      case 'enum':
        ctx = 'enumValue';
        break;
      case 'params':
        ctx = isIndex(seg) ? 'param' : 'unknown';
        break;
      case 'attribute':
      case 'instance':
        ctx = seg === 'type' ? 'switch' : seg === 'valid' ? 'valid' : 'scalar';
        break;
      case 'switch':
        ctx = seg === 'cases' ? 'cases' : 'scalar';
        break;
      case 'cases':
      case 'valid':
      case 'xref':
      case 'imports':
      case 'enumValue':
      case 'param':
        ctx = 'scalar';
        break;
      default:
        ctx = 'unknown';
    }
  }
  return {
    ctx,
    typePath,
    enumName,
    key: path.length ? key : undefined,
    parentCtx: path.length ? parentCtx : undefined,
  };
}

function resolveRef(node: Json): Json {
  let n = node;
  for (let i = 0; i < 10 && n?.$ref; i++) {
    const name = String(n.$ref).replace('#/definitions/', '');
    n = { ...KSY_SCHEMA.definitions[name], ...Object.fromEntries(Object.entries(n).filter(([k]) => k !== '$ref')) };
  }
  return n;
}

/** All object properties of a schema node, merging anyOf/allOf variants. */
function propertiesOf(node: Json): Record<string, Json> {
  const n = resolveRef(node);
  const out: Record<string, Json> = { ...(n?.properties ?? {}) };
  for (const variant of [...(n?.anyOf ?? []), ...(n?.allOf ?? [])]) {
    for (const [k, v] of Object.entries(propertiesOf(variant))) out[k] ??= v;
  }
  return out;
}

function descriptionOf(node: Json): string | undefined {
  if (!node) return undefined;
  if (typeof node.description === 'string') return node.description;
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
  const out = new Set<string>();
  for (const v of r.enum ?? []) out.add(String(v));
  if (r.type === 'boolean') {
    out.add('true');
    out.add('false');
  }
  for (const v of r.anyOf ?? []) for (const x of valuesOf(v)) out.add(x);
  return [...out];
}

const DEFS = KSY_SCHEMA.definitions;

const SWITCH = {
  'switch-on': { description: 'expression whose value selects the type from `cases`' },
  cases: { description: 'map of `switch-on` values (expressions) to types; `_` is the default case' },
};

function schemaForContext(ctx: KsyContext): Record<string, Json> {
  switch (ctx) {
    case 'root':
      return KSY_SCHEMA.properties;
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
      return SWITCH;
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
  /** The value is a block (mapping or list) rather than a scalar. */
  block: 'map' | 'list' | undefined;
}

const BLOCK_KEYS: Record<string, 'map' | 'list'> = {
  meta: 'map',
  seq: 'list',
  instances: 'map',
  types: 'map',
  enums: 'map',
  params: 'list',
  xref: 'map',
  imports: 'list',
  cases: 'map',
};

/** Keys allowed in the mapping of the given context. */
export function keysFor(ctx: KsyContext): KeyInfo[] {
  return Object.entries(schemaForContext(ctx)).map(([key, node]) => ({
    key,
    doc: descriptionOf(node) ?? descriptionOf(DOC_FALLBACK[key]),
    values: valuesOf(node),
    block: BLOCK_KEYS[key],
  }));
}

const DOC_FALLBACK: Record<string, Json> = {
  doc: DEFS.Doc,
  'doc-ref': DEFS.DocRef,
  'to-string': DEFS.ToString,
  encoding: DEFS.CharacterEncoding,
};

/** Documentation of one key in a context. */
export function keyInfo(ctx: KsyContext, key: string): KeyInfo | undefined {
  return keysFor(ctx).find((k) => k.key === key);
}

/** Canonical character encodings known to the compiler. */
export const ENCODINGS: readonly string[] = DEFS.CharacterEncoding.enum;

/** Keys whose values are Kaitai expressions. */
export const EXPRESSION_KEYS = new Set([
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
