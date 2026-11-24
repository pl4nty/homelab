// Compiles .ksy specs with the Kaitai Struct compiler (debug mode) and turns parsed objects into
// StructureNodes. No `vscode` import, so it runs under plain Node for tests.
import { unzlibSync } from 'fflate';
import KaitaiStreamModule from 'kaitai-struct/KaitaiStream.js';
import compilerModule from 'kaitai-struct-compiler';
import { parse as parseYaml } from 'yaml';
import { toLowerCamel, toSnake, toUpperCamel } from '../util/names.ts';
import type { ByteRange, FieldDef, NodeKind, ParseResult, StructureNode } from './structure.ts';

// The packages ship UMD without usable typings for this TS config.
// biome-ignore lint/suspicious/noExplicitAny: untyped UMD modules
type Any = any;

const KaitaiStream: Any = KaitaiStreamModule;
const compiler: Any = compilerModule;

// The runtime picks Node's zlib + Buffer whenever `require` exists, which is also true in the VS Code
// web extension host (it supplies a CommonJS `require` but no Buffer). Use fflate everywhere.
KaitaiStream.processZlib = (buf: Uint8Array) => unzlibSync(buf);

/** Compiler target languages, as accepted by {@link generateCode}. */
export const LANGUAGES: readonly string[] = compiler.languages;

/**
 * Reads an imported spec. `mode` is `rel` for a path relative to the importing spec and `abs`
 * for a path relative to a format library root. Returns YAML source.
 */
export type ImportReader = (name: string, mode: 'rel' | 'abs') => Promise<string>;

export class KsyError extends Error {
  /** YAML path such as `['seq', '2', 'type']`, when the compiler reports one. */
  readonly path?: string[];
  /** Name of the spec the error is in, for errors inside imports. */
  readonly file?: string;
  constructor(message: string, path?: string[], file?: string) {
    super(message);
    this.path = path;
    this.file = file;
  }
}

export interface Template {
  /** meta/id */
  readonly id: string;
  readonly title: string;
  /** meta/file-extension, lower case. */
  readonly fileExtensions: readonly string[];
  readonly endian?: string;
  /** All specs that took part (root first): id -> parsed YAML. */
  readonly specs: ReadonlyMap<string, Any>;
  /** Top-level `params`, which the root type's constructor takes after (_io, _parent, _root). */
  readonly params: readonly TemplateParam[];
  /** User type names that can be parsed on their own, as `a::b` paths, for "parse selection as". */
  readonly typeNames: readonly string[];
  parse(data: Uint8Array, opts?: ParseOptions): ParseResult;
}

export interface TemplateParam {
  id: string;
  type?: string;
  doc?: string;
}

export interface ParseOptions {
  /** Values for the root's `params`, in order. */
  params?: unknown[];
  /** Parse as this user type (`a::b`) instead of the root type. */
  typeName?: string;
  /** Document offset of data[0]; ranges are shifted by it. */
  baseOffset?: number;
  /** Name of the root node. Defaults to the spec id. */
  rootName?: string;
}

interface DebugInfo {
  start?: number;
  end?: number;
  ioOffset?: number;
  enumName?: string;
  arr?: DebugInfo[];
  /** Set by the generated code when a `valid:` check fails. */
  validationError?: unknown;
}

type KObject = { _io: Any; _debug?: Record<string, DebugInfo>; constructor: Any; [field: string]: Any };

const MAX_CHILDREN = 100;
const BYTES_PREVIEW = 16;
const STRING_PREVIEW = 100;

function parseKsy(source: string): Any {
  const spec = parseYaml(source, { uniqueKeys: false, maxAliasCount: -1 });
  if (!spec || typeof spec !== 'object') throw new KsyError('Spec is not a YAML mapping');
  return spec;
}

/** Runs the compiler. Imported specs are added to `specs` by their meta/id. */
async function compile(
  lang: string,
  spec: Any,
  readImport: ImportReader,
  debug: boolean,
  specs?: Map<string, Any>,
): Promise<Record<string, string>> {
  const importYaml = async (name: string, mode: 'rel' | 'abs') => {
    const imported = parseKsy(await readImport(name, mode));
    const id = imported.meta?.id;
    if (typeof id === 'string' && !specs?.has(id)) specs?.set(id, imported);
    return imported;
  };
  try {
    return await compiler.compile(lang, spec, { importYaml }, debug);
  } catch (e) {
    throw toKsyError(e);
  }
}

/** Converts a compiler exception into a KsyError with the YAML path, when it has one. */
export function toKsyError(e: unknown): KsyError {
  if (e instanceof KsyError) return e;
  // Scala.js exceptions stringify as "<java class>: <message>". Compilation problems look like
  // "<spec id or (main)>: /seq/0/type:\n\terror: unable to find type 'foo', searching from x".
  const msg = String((e as Error)?.message && !String(e).includes('Exception') ? (e as Error).message : e)
    .replace(/^[\w.$]+(Exception|Error): /, '')
    .trim();
  const m = /^(\S+): (\/[^\s:]*):\s*(?:(?:error|warning): )?(.*)$/s.exec(msg);
  if (!m) return new KsyError(msg);
  return new KsyError(m[3].trim(), m[2].split('/').filter(Boolean), m[1] === '(main)' ? undefined : m[1]);
}

/** Compiles to another language for the "generated code" view. Returns file name -> source. */
export async function generateCode(source: string, lang: string, readImport: ImportReader, debug = false) {
  return compile(lang, parseKsy(source), readImport, debug);
}

/** Compiles a .ksy into a template whose parser builds StructureNodes. */
export async function compileTemplate(source: string, readImport: ImportReader): Promise<Template> {
  const spec = parseKsy(source);
  const id: unknown = spec.meta?.id;
  if (typeof id !== 'string') throw new KsyError('Spec has no meta/id', ['meta', 'id']);
  const specs = new Map<string, Any>([[id, spec]]);
  const modules = evaluateModules(await compile('javascript', spec, readImport, true, specs));
  const className = toUpperCamel(id);
  const RootClass = modules.get(className)?.[className];
  if (typeof RootClass !== 'function') throw new KsyError(`Compiled spec does not export ${className}`);

  const names = new Map<string, string>();
  const classes = new Map<string, Any>();
  for (const [specId, s] of specs) {
    for (const t of types(specId, s)) {
      // The root spec comes first, so its types win over imported ones of the same name.
      if (!classes.has(toUpperCamel(t.name))) classes.set(toUpperCamel(t.name), t.spec);
      for (const f of Array.isArray(t.spec.seq) ? t.spec.seq : [])
        if (typeof f?.id === 'string') names.set(toLowerCamel(f.id), f.id);
      for (const k of Object.keys(t.spec.instances ?? {})) names.set(toLowerCamel(k), k);
    }
  }
  const ext = spec.meta['file-extension'] ?? [];
  return {
    id,
    title: spec.meta.title || id,
    fileExtensions: (Array.isArray(ext) ? ext : [ext]).map((e) => String(e).toLowerCase()),
    endian: typeof spec.meta.endian === 'string' ? spec.meta.endian : undefined,
    specs,
    params: (Array.isArray(spec.params) ? spec.params : [])
      .filter((p: Any) => typeof p?.id === 'string')
      .map((p: Any) => ({ id: p.id, type: typeof p.type === 'string' ? p.type : undefined, doc: p.doc })),
    typeNames: Array.from(types(id, spec), (t) => t.path).slice(1),
    parse(data, { params = [], typeName, baseOffset: base = 0, rootName = id } = {}) {
      // The stream needs an ArrayBuffer that holds exactly the data.
      const exact = data.byteLength === data.buffer.byteLength ? data : data.slice();
      const ctx: Ctx = { buffer: exact.buffer as ArrayBuffer, modules, names, base, classes };
      let Class: Any = RootClass;
      for (const part of typeName?.split('::') ?? []) Class = Class?.[toUpperCamel(part)];
      if (typeof Class !== 'function') return { roots: [], error: `Unknown type ${typeName}` };
      let root: KObject;
      let error: string | undefined;
      try {
        // A non-root type's _root is itself; params apply to the root type only.
        root = new Class(new KaitaiStream(ctx.buffer), undefined, undefined, ...(typeName ? [] : params));
      } catch (e) {
        return { roots: [], error: errorMessage(e) };
      }
      try {
        root._read();
      } catch (e) {
        error = errorMessage(e);
      }
      const range = { start: base, end: base + data.byteLength };
      return { roots: [structNode(ctx, undefined, rootName, root, { range, error })], error };
    },
  };
}

/** A type spec and the types nested in it, depth first, with `a::b` paths below the first one. */
function* types(name: string, spec: Any, path = ''): Generator<{ name: string; path: string; spec: Any }> {
  if (!spec || typeof spec !== 'object') return;
  yield { name, path, spec };
  for (const [k, sub] of Object.entries(spec.types ?? {})) yield* types(k, sub, path ? `${path}::${k}` : k);
}

/** Runs compiled UMD modules through a minimal CommonJS loader. */
function evaluateModules(files: Record<string, string>): Map<string, Any> {
  const modules = new Map<string, Any>();
  const load = (name: string): Any => {
    let exports = modules.get(name);
    if (exports) return exports;
    const code = files[`${name}.js`];
    if (code === undefined) throw new KsyError(`Compiled spec is missing module ${name}`);
    exports = {};
    modules.set(name, exports); // before running, for circular imports
    // `define` is shadowed so the UMD wrapper takes the CommonJS branch.
    new Function('exports', 'require', 'define', code)(exports, req, undefined);
    return exports;
  };
  const req = (mod: string) => {
    if (mod === 'kaitai-struct/KaitaiStream') return KaitaiStream;
    if (mod.startsWith('./')) return load(mod.slice(2));
    throw new Error(`Unexpected module ${mod}`);
  };
  for (const file of Object.keys(files)) load(file.replace(/\.js$/, ''));
  return modules;
}

interface Ctx {
  buffer: ArrayBuffer;
  modules: Map<string, Any>;
  /** Generated JS property name -> .ksy id, so ids with digits (`icc_4` -> `icc4`) survive. */
  names: Map<string, string>;
  /** Document offset of buffer[0]. */
  base: number;
  /** Generated class name -> type spec, for `-webide-representation`. */
  classes: Map<string, Any>;
}

type NodeProps = Omit<StructureNode, 'id' | 'name' | 'parent' | 'kind' | 'hasChildren' | 'children'>;

function makeNode(
  parent: StructureNode | undefined,
  name: string,
  kind: NodeKind,
  props: NodeProps,
  getChildren?: (self: StructureNode) => StructureNode[],
): StructureNode {
  let cached: StructureNode[] | undefined;
  const self: StructureNode = {
    ...props,
    id: parent ? `${parent.id}/${name}` : name,
    name,
    parent,
    kind,
    hasChildren: !!getChildren,
    children() {
      cached ??= getChildren?.(self) ?? [];
      return cached;
    },
  };
  return self;
}

const isStruct = (v: unknown): v is KObject => typeof v === 'object' && v !== null && '_io' in v;
const isNumber = (v: unknown): v is number | bigint => typeof v === 'number' || typeof v === 'bigint';

/**
 * Document range of a debug entry. A field that started but never finished (where parsing
 * failed) gets one byte. Fields inside processed (e.g. decompressed) streams have none.
 */
function documentRange(ctx: Ctx, io: Any, dbg: DebugInfo | undefined): ByteRange | undefined {
  // `_buffer` is read directly because the public `buffer` getter copies substream buffers.
  if (dbg?.start === undefined || io?._buffer !== ctx.buffer) return undefined;
  const offset = dbg.ioOffset ?? 0;
  const start = offset + dbg.start;
  const end = dbg.end === undefined ? Math.min(start + 1, ctx.buffer.byteLength) : offset + dbg.end;
  return end < start ? undefined : { start: ctx.base + start, end: ctx.base + end };
}

function structNode(
  ctx: Ctx,
  parent: StructureNode | undefined,
  name: string,
  obj: KObject,
  props: NodeProps,
): StructureNode {
  const buf = obj._io?._buffer;
  const type: string | undefined = obj.constructor?.name;
  // Structs read from a processed (e.g. decompressed) stream expose those bytes, so they can be
  // opened in their own hex editor.
  const streamBytes =
    buf instanceof ArrayBuffer && buf !== ctx.buffer
      ? () => new Uint8Array(buf, obj._io._byteOffset ?? 0, obj._io._byteLength ?? buf.byteLength)
      : undefined;
  return makeNode(parent, name, 'struct', { ...props, type, value: representation(ctx, obj), streamBytes }, (self) =>
    structFields(ctx, self, obj),
  );
}

/**
 * Renders a type's `-webide-representation`, e.g. `{name}: {value:dec}`. Field references are
 * seq ids or instances; `:hex` and `:str` pick the format. Errors render as `?`.
 */
function representation(ctx: Ctx, obj: KObject): string | undefined {
  const tmpl = ctx.classes.get(obj.constructor?.name)?.['-webide-representation'];
  if (typeof tmpl !== 'string') return undefined;
  return tmpl.replace(/\{([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*)(?::(\w+))?\}/g, (_, path: string, fmt?: string) => {
    try {
      let v: Any = obj;
      for (const part of path.split('.')) v = v?.[toLowerCamel(part)];
      if (v === undefined || v === null) return '';
      if (v instanceof Uint8Array) return fmt === 'str' ? new TextDecoder().decode(v) : formatValue(v);
      if (isNumber(v) && fmt === 'hex') return `0x${v.toString(16).toUpperCase()}`;
      if (isStruct(v)) return representation(ctx, v) ?? v.constructor?.name ?? '';
      return String(v);
    } catch {
      return '?';
    }
  });
}

function structFields(ctx: Ctx, self: StructureNode, obj: KObject): StructureNode[] {
  const debug = obj._debug ?? {};
  const type: string = obj.constructor?.name ?? '';
  const def = (key: string): FieldDef => ({ type, field: ctx.names.get(key) ?? toSnake(key) });
  const field = (key: string, value: unknown, dbg: DebugInfo | undefined, instance?: true) =>
    valueNode(ctx, self, def(key).field, value, obj._io, dbg, def(key), instance);

  // Debug entries of instances are named `_m_<name>`; the rest are the seq fields, in order.
  const nodes = Object.entries(debug)
    .filter(([key]) => !key.startsWith('_m_'))
    .map(([key, dbg]) => field(key, obj[key], dbg));

  // Instances are lazy getters on the prototype; reading one parses it.
  const proto = Object.getPrototypeOf(obj);
  for (const [key, desc] of Object.entries(Object.getOwnPropertyDescriptors(proto))) {
    if (!desc.get) continue;
    try {
      nodes.push(field(key, obj[key], debug[`_m_${key}`], true));
    } catch (e) {
      const range = documentRange(ctx, obj._io, debug[`_m_${key}`]);
      nodes.push(
        makeNode(self, def(key).field, 'other', { error: errorMessage(e), instance: true, range, def: def(key) }),
      );
    }
  }
  return nodes;
}

function valueNode(
  ctx: Ctx,
  parent: StructureNode,
  name: string,
  value: unknown,
  io: Any,
  dbg: DebugInfo | undefined,
  def: FieldDef | undefined,
  instance?: true,
): StructureNode {
  const struct = isStruct(value);
  const props: NodeProps = {
    // Bit fields: the debug range is in bytes, so a 3-bit field shows the byte it lives in.
    range: documentRange(ctx, io, dbg),
    error: dbg?.validationError
      ? `Validation failed: ${errorMessage(dbg.validationError)}`
      : dbg?.start !== undefined && dbg.end === undefined
        ? 'Parsing stopped here'
        : undefined,
    def,
    instance,
  };
  if (struct) return structNode(ctx, parent, name, value, props);
  if (Array.isArray(value)) {
    return makeNode(parent, name, 'array', { ...props, value: `[${value.length}]` }, (self) =>
      arrayItems(ctx, self, value, io, dbg?.arr ?? [], 0, value.length, def),
    );
  }
  if (value === undefined || value === null) return makeNode(parent, name, 'other', props);
  const enumName = isNumber(value) ? dbg?.enumName : undefined;
  const label = enumName && lookupEnum(ctx, enumName, value as number | bigint);
  return makeNode(parent, name, enumName ? 'enum' : kindOf(value), {
    ...props,
    raw: value,
    value: label ? `${label} = ${formatValue(value)}` : formatValue(value),
    type: enumName,
  });
}

function kindOf(value: unknown): NodeKind {
  if (value instanceof Uint8Array) return 'bytes';
  if (isNumber(value)) return 'number';
  return typeof value === 'string' || typeof value === 'boolean' ? (typeof value as NodeKind) : 'other';
}

/** Items `from..to` of an array, grouped into buckets of up to MAX_CHILDREN when there are more. */
function arrayItems(
  ctx: Ctx,
  parent: StructureNode,
  array: unknown[],
  io: Any,
  arr: DebugInfo[],
  from: number,
  to: number,
  def: FieldDef | undefined,
): StructureNode[] {
  const nodes: StructureNode[] = [];
  if (to - from <= MAX_CHILDREN) {
    for (let i = from; i < to; i++) nodes.push(valueNode(ctx, parent, `[${i}]`, array[i], io, arr[i], def));
    return nodes;
  }
  let step = MAX_CHILDREN;
  while ((to - from) / step > MAX_CHILDREN) step *= MAX_CHILDREN;
  for (let lo = from; lo < to; lo += step) {
    const hi = Math.min(lo + step, to);
    const first = documentRange(ctx, io, arr[lo]);
    const last = documentRange(ctx, io, arr[hi - 1]);
    const range = first && last && { start: first.start, end: last.end };
    nodes.push(
      makeNode(parent, `[${lo}..${hi - 1}]`, 'bucket', { range }, (self) =>
        arrayItems(ctx, self, array, io, arr, lo, hi, def),
      ),
    );
  }
  return nodes;
}

function formatValue(value: unknown): string {
  if (value instanceof Uint8Array) {
    const hex = Array.from(value.subarray(0, BYTES_PREVIEW), (b) => b.toString(16).padStart(2, '0').toUpperCase());
    return value.length > BYTES_PREVIEW ? `${hex.join(' ')} … (${value.length} bytes)` : hex.join(' ');
  }
  if (typeof value === 'string') {
    const json = JSON.stringify(value);
    return json.length > STRING_PREVIEW ? `${json.slice(0, STRING_PREVIEW)}…"` : json;
  }
  if (typeof value === 'bigint' || Number.isInteger(value)) {
    const n = value as number | bigint;
    return `${n} (${n < 0 ? '-' : ''}0x${(n < 0 ? -n : n).toString(16).toUpperCase()})`;
  }
  return String(value);
}

/** Resolves an enum label from a debug enum name like `Png.ColorType`. */
function lookupEnum(ctx: Ctx, enumName: string, value: number | bigint) {
  const [moduleName, ...path] = enumName.split('.');
  let target = ctx.modules.get(moduleName)?.[moduleName];
  for (const part of path) target = target?.[part];
  const label = target?.[String(value)];
  return typeof label === 'string' ? label.toLowerCase() : undefined;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  // KaitaiStream throws plain objects/strings in some versions.
  return String((e as Any)?.message ?? e);
}
