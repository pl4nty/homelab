// Compiles .ksy specs with the Kaitai Struct compiler (debug mode) and turns parsed objects into
// StructureNodes. No `vscode` import, so it runs under plain Node for tests.
import { unzlibSync } from 'fflate';
import { parse as parseYaml } from 'yaml';
import type { ByteRange, FieldDef, NodeKind, ParseResult, StructureNode } from './structure.ts';

// The packages ship UMD without usable typings for this TS config.
// biome-ignore lint/suspicious/noExplicitAny: untyped UMD modules
type Any = any;
import KaitaiStreamModule from 'kaitai-struct/KaitaiStream.js';
import compilerModule from 'kaitai-struct-compiler';

const KaitaiStream: Any = KaitaiStreamModule;
const compiler: Any = compilerModule;

// The runtime picks Node's zlib when `require` exists and pako otherwise; give it fflate for both.
KaitaiStream.zlib = {
  inflateSync: (buf: Uint8Array) => unzlibSync(buf),
  inflate: (buf: Uint8Array) => unzlibSync(buf),
};

/** Compiler target languages, as accepted by {@link generateCode}. */
export const LANGUAGES: readonly string[] = compiler.languages;
export const COMPILER_VERSION: string = compiler.version;

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
  readonly fileExtensions: readonly string[];
  readonly endian?: string;
  /** All specs that took part (root first): id -> parsed YAML. */
  readonly specs: ReadonlyMap<string, Any>;
  parse(data: Uint8Array): ParseResult;
}

interface DebugInfo {
  start?: number;
  end?: number;
  ioOffset?: number;
  enumName?: string;
  arr?: DebugInfo[];
}

type KObject = { _io: Any; _debug?: Record<string, DebugInfo>; _parent?: KObject; constructor: Any };

const MAX_CHILDREN = 100;
const BYTES_PREVIEW = 16;
const STRING_PREVIEW = 100;

export function parseKsy(source: string): Any {
  const spec = parseYaml(source, { uniqueKeys: false, maxAliasCount: -1 });
  if (!spec || typeof spec !== 'object') throw new KsyError('Spec is not a YAML mapping');
  return spec;
}

async function compileRaw(lang: string, spec: Any, readImport: ImportReader, debug: boolean, specs: Map<string, Any>) {
  try {
    return (await compiler.compile(
      lang,
      spec,
      {
        importYaml: async (name: string, mode: 'rel' | 'abs') => {
          const imported = parseKsy(await readImport(name, mode));
          const id = imported?.meta?.id;
          if (typeof id === 'string' && !specs.has(id)) specs.set(id, imported);
          return imported;
        },
      },
      debug,
    )) as Record<string, string>;
  } catch (e) {
    throw toKsyError(e);
  }
}

/** Converts a compiler exception into a KsyError with the YAML path, when it has one. */
export function toKsyError(e: unknown): KsyError {
  if (e instanceof KsyError) return e;
  // Scala.js exceptions stringify as "<java class>: <message>". Compilation problems look like
  // "<spec id or (main)>: /seq/0/type:\n\terror: unable to find type 'foo', searching from x".
  const msg = String((e as Error)?.message && !(String(e).includes('Exception')) ? (e as Error).message : e)
    .replace(/^[\w.$]+(Exception|Error): /, '')
    .trim();
  const m = /^(\S+): (\/[^\s:]*):\s*(?:(error|warning): )?(.*)$/s.exec(msg);
  if (m) {
    const file = m[1] === '(main)' ? undefined : m[1];
    return new KsyError(m[4].trim(), m[2].split('/').filter(Boolean), file);
  }
  return new KsyError(msg);
}

/** Compiles to another language for the "generated code" view. Returns file name -> source. */
export async function generateCode(source: string, lang: string, readImport: ImportReader, debug = false) {
  return compileRaw(lang, parseKsy(source), readImport, debug, new Map());
}

/** Compiles a .ksy into a template whose parser builds StructureNodes. */
export async function compileTemplate(source: string, readImport: ImportReader): Promise<Template> {
  const spec = parseKsy(source);
  const id: unknown = spec?.meta?.id;
  if (typeof id !== 'string') throw new KsyError('Spec has no meta/id', ['meta', 'id']);
  const specs = new Map<string, Any>([[id, spec]]);
  const files = await compileRaw('javascript', spec, readImport, true, specs);
  const modules = evaluateModules(files);
  const className = toUpperCamel(id);
  const RootClass = modules.get(className)?.[className];
  if (typeof RootClass !== 'function') throw new KsyError(`Compiled spec does not export ${className}`);

  const names = fieldNames(specs.values());
  const ext = spec.meta['file-extension'];
  return {
    id,
    title: spec.meta.title || id,
    fileExtensions: (Array.isArray(ext) ? ext : ext ? [ext] : []).map(String),
    endian: typeof spec.meta.endian === 'string' ? spec.meta.endian : undefined,
    specs,
    parse(data) {
      const buffer =
        data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
          ? (data.buffer as ArrayBuffer)
          : (data.slice().buffer as ArrayBuffer);
      const ctx: Ctx = { buffer, modules, names, rootId: id };
      let root: KObject;
      let error: string | undefined;
      try {
        root = new RootClass(new KaitaiStream(buffer));
      } catch (e) {
        return { roots: [], error: errorMessage(e) };
      }
      try {
        (root as Any)._read();
      } catch (e) {
        error = errorMessage(e);
      }
      const node = structNode(ctx, undefined, id, root, { start: 0, end: data.byteLength }, undefined, error);
      return { roots: [node], error };
    },
  };
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
  /** Generated JS property name -> .ksy id. */
  names: Map<string, string>;
  rootId: string;
}

class Node implements StructureNode {
  readonly id: string;
  declare readonly type?: string;
  declare readonly value?: string;
  declare readonly raw?: unknown;
  declare readonly range?: ByteRange;
  declare readonly bits?: number;
  declare readonly instance?: boolean;
  declare readonly error?: string;
  declare readonly def?: FieldDef;
  readonly parent: Node | undefined;
  readonly name: string;
  readonly kind: NodeKind;
  private readonly getChildren?: (self: Node) => StructureNode[];
  private cached?: StructureNode[];

  constructor(
    parent: Node | undefined,
    name: string,
    kind: NodeKind,
    props: Partial<Omit<StructureNode, 'id' | 'name' | 'parent' | 'kind' | 'hasChildren' | 'children'>>,
    getChildren?: (self: Node) => StructureNode[],
  ) {
    this.parent = parent;
    this.name = name;
    this.kind = kind;
    this.getChildren = getChildren;
    this.id = parent ? `${parent.id}/${name}` : name;
    for (const [k, v] of Object.entries(props)) if (v !== undefined) (this as Any)[k] = v;
  }

  get hasChildren() {
    return !!this.getChildren;
  }

  children() {
    this.cached ??= this.getChildren?.(this) ?? [];
    return this.cached;
  }
}

const isStruct = (v: unknown): v is KObject => typeof v === 'object' && v !== null && '_io' in v;

function absoluteRange(ctx: Ctx, io: Any, dbg: DebugInfo | undefined): ByteRange | undefined {
  // Fields inside processed (e.g. decompressed) streams have no document offset. `_buffer` is
  // read directly because the public `buffer` getter copies substream buffers.
  if (dbg?.start === undefined || dbg.end === undefined || io?._buffer !== ctx.buffer) return undefined;
  const base = dbg.ioOffset ?? 0;
  return { start: base + dbg.start, end: base + dbg.end };
}


function structNode(
  ctx: Ctx,
  parent: Node | undefined,
  name: string,
  obj: KObject,
  range: ByteRange | undefined,
  def: FieldDef | undefined,
  error?: string,
): Node {
  return new Node(
    parent,
    name,
    'struct',
    { type: obj.constructor?.name, range, error, def },
    (self) => structFields(ctx, self, obj),
  );
}

function structFields(ctx: Ctx, self: Node, obj: KObject): StructureNode[] {
  const nodes: StructureNode[] = [];
  const debug = obj._debug ?? {};
  const type: string = obj.constructor?.name ?? '';

  for (const [key, dbg] of Object.entries(debug)) {
    if (key.startsWith('_m_')) continue;
    const field = ksyName(ctx, key);
    nodes.push(valueNode(ctx, self, field, (obj as Any)[key], obj._io, dbg, { type, field }, false));
  }

  // Instances are lazy getters on the prototype; reading one parses it.
  const proto = Object.getPrototypeOf(obj);
  for (const key of Object.getOwnPropertyNames(proto)) {
    if (!Object.getOwnPropertyDescriptor(proto, key)?.get) continue;
    const field = ksyName(ctx, key);
    try {
      const value = (obj as Any)[key];
      nodes.push(valueNode(ctx, self, field, value, obj._io, debug[`_m_${key}`], { type, field }, true));
    } catch (e) {
      // A failed instance may still have a start position.
      const dbg = debug[`_m_${key}`];
      nodes.push(
        new Node(self, field, 'other', {
          error: errorMessage(e),
          instance: true,
          range: dbg?.start !== undefined ? absoluteRange(ctx, obj._io, { ...dbg, end: dbg.end ?? dbg.start + 1 }) : undefined,
          def: { type, field },
        }),
      );
    }
  }
  return nodes;
}

function valueNode(
  ctx: Ctx,
  parent: Node,
  name: string,
  value: unknown,
  io: Any,
  dbg: DebugInfo | undefined,
  def: FieldDef | undefined,
  instance: boolean,
): Node {
  let range = absoluteRange(ctx, io, dbg);
  // A field that started but never finished is where parsing failed.
  const failed = dbg?.start !== undefined && dbg.end === undefined;
  const error = failed ? 'Parsing stopped here' : undefined;
  if (failed && io?._buffer === ctx.buffer) {
    const s = (dbg.ioOffset ?? 0) + dbg.start!;
    range = { start: s, end: Math.min(s + 1, ctx.buffer.byteLength) };
  }
  const base = { range, error, def, instance: instance || undefined };
  if (isStruct(value)) return structNode(ctx, parent, name, value, range, def, error);
  if (Array.isArray(value)) {
    return new Node(parent, name, 'array', { ...base, value: `[${value.length}]` }, (self) =>
      arrayItems(ctx, self, value, io, dbg?.arr ?? [], 0, value.length, def),
    );
  }
  if (value === undefined || value === null) return new Node(parent, name, 'other', base);
  const enumLabel = dbg?.enumName && (typeof value === 'number' || typeof value === 'bigint') ? lookupEnum(ctx, dbg.enumName, value) : undefined;
  const kind: NodeKind =
    value instanceof Uint8Array
      ? 'bytes'
      : typeof value === 'string'
        ? 'string'
        : typeof value === 'boolean'
          ? 'boolean'
          : dbg?.enumName
            ? 'enum'
            : typeof value === 'number' || typeof value === 'bigint'
              ? 'number'
              : 'other';
  // Bit fields: the debug range is in bytes, so a 3-bit field shows the byte it lives in.
  return new Node(parent, name, kind, { ...base, raw: value, value: formatValue(value, enumLabel), type: dbg?.enumName });
}

function arrayItems(
  ctx: Ctx,
  parent: Node,
  array: unknown[],
  io: Any,
  arr: DebugInfo[],
  from: number,
  to: number,
  def: FieldDef | undefined,
): StructureNode[] {
  const nodes: StructureNode[] = [];
  if (to - from <= MAX_CHILDREN) {
    for (let i = from; i < to; i++) nodes.push(valueNode(ctx, parent, `[${i}]`, array[i], io, arr[i], def, false));
    return nodes;
  }
  let step = MAX_CHILDREN;
  while ((to - from) / step > MAX_CHILDREN) step *= MAX_CHILDREN;
  for (let lo = from; lo < to; lo += step) {
    const hi = Math.min(lo + step, to);
    const first = absoluteRange(ctx, io, arr[lo]);
    const last = absoluteRange(ctx, io, arr[hi - 1]);
    nodes.push(
      new Node(parent, `[${lo}..${hi - 1}]`, 'bucket', { range: first && last && { start: first.start, end: last.end } }, (self) =>
        arrayItems(ctx, self, array, io, arr, lo, hi, def),
      ),
    );
  }
  return nodes;
}

export function formatValue(value: unknown, enumLabel?: string): string {
  if (value instanceof Uint8Array) {
    const hex = Array.from(value.subarray(0, BYTES_PREVIEW), (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    return value.length > BYTES_PREVIEW ? `${hex} … (${value.length} bytes)` : hex;
  }
  if (typeof value === 'string') {
    const json = JSON.stringify(value);
    return json.length > STRING_PREVIEW ? `${json.slice(0, STRING_PREVIEW)}…"` : json;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    const num =
      Number.isInteger(value) || typeof value === 'bigint'
        ? `${value} (${value < 0 ? '-' : ''}0x${(value < 0 ? -value : value).toString(16).toUpperCase()})`
        : String(value);
    return enumLabel ? `${enumLabel} = ${num}` : num;
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

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  // KaitaiStream throws plain objects/strings in some versions.
  return String((e as Any)?.message ?? e);
}

/** `my_format` -> `MyFormat`, matching the compiler's class naming. */
export function toUpperCamel(id: string) {
  return id
    .split('_')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

/** `num_entries` -> `numEntries`, matching the compiler's JS field naming. */
export function toLowerCamel(id: string) {
  const u = toUpperCamel(id);
  return u.charAt(0).toLowerCase() + u.slice(1);
}

function toSnake(name: string) {
  return name.replace(/(?<=[a-z0-9])[A-Z]/g, (c) => `_${c.toLowerCase()}`).toLowerCase();
}

/** Maps generated JS names back to .ksy ids, so ids with digits (`icc_4` -> `icc4`) survive. */
function fieldNames(specs: Iterable<Any>): Map<string, string> {
  const names = new Map<string, string>();
  const visitType = (t: Any) => {
    if (!t || typeof t !== 'object') return;
    for (const f of Array.isArray(t.seq) ? t.seq : []) if (typeof f?.id === 'string') names.set(toLowerCamel(f.id), f.id);
    for (const k of Object.keys(t.instances ?? {})) names.set(toLowerCamel(k), k);
    for (const sub of Object.values(t.types ?? {})) visitType(sub);
  };
  for (const s of specs) visitType(s);
  return names;
}

function ksyName(ctx: Ctx, jsName: string) {
  return ctx.names.get(jsName) ?? toSnake(jsName);
}
