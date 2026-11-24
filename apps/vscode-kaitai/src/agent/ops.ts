// The operations behind the `kaitai` CLI and MCP server: parse, at, validate, suggest and compile. Results are plain
// JSON with size caps, so they can go straight into an agent's context. No vscode import.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { compileTemplate, generateCode, KsyError, LANGUAGES, type Template } from '../engine/kaitai.ts';
import { findDeepestNode, type ParseResult, type StructureNode } from '../engine/structure.ts';
import { extensionOf, suggestFor } from '../gallery/suggest.ts';
import { diagnosticTargetPath, isImportedError, suggestionsFor, unresolvedName } from '../ksy/language.ts';
import type { TypeInfo } from '../ksy/model.ts';
import { parseKsyDocument, rangeForPath } from '../ksy/yamlAst.ts';
import { INVALID, parseParamValue } from '../util/parse.ts';
import { type LoadedSpec, type SourceOptions, SpecLoader } from './source.ts';

export { LANGUAGES };

/** Where a spec comes from: exactly one of `spec` (path or `gallery:<path>`) and `source` (inline YAML). */
export interface SpecInput {
  spec?: string;
  source?: string;
}

export interface Limits {
  /** Struct nesting levels to expand below the start node. */
  depth?: number;
  /** Array items to show per array. */
  maxItems?: number;
  /** Nodes to emit in total; past it, nodes are cut off and marked. */
  maxNodes?: number;
  /** Bytes of a byte array to show as hex. */
  maxBytes?: number;
  /** Characters of a string to show. */
  maxString?: number;
}

export interface ParseInput extends SpecInput, Limits {
  file: string;
  /** Node path such as `png/chunks/3/body` or `chunks[3].body`. Defaults to the root. */
  path?: string;
  /** First array item to show when `path` is an array. */
  from?: number;
  /** Parse as this user type (`a::b`) instead of the root type. */
  typeName?: string;
  /** Values for the root type's `params`, in order. Strings are parsed like the IDE's param prompt. */
  params?: unknown[];
  /** Leave out `instances:` (they may read data anywhere in the file). */
  noInstances?: boolean;
}

export interface JsonNode {
  name: string;
  kind: string;
  /** Kaitai type (struct class or enum). */
  type?: string;
  value?: unknown;
  /** Enum label of `value`. */
  enum?: string;
  /** Byte length of a byte array or the length of a string, when `value` is cut. */
  size?: number;
  /** [start, end) offsets in the file. Absent inside processed (e.g. decompressed) streams. */
  range?: [number, number];
  instance?: true;
  error?: string;
  /** Rendered `-webide-representation`. */
  summary?: string;
  fields?: JsonNode[];
  items?: JsonNode[];
  /** Number of items of an array. */
  count?: number;
  /** Index of the first item in `items`, when not 0. */
  from?: number;
  /** Why children are missing: `depth`, `items` (more items than shown) or `nodes` (output budget). */
  truncated?: 'depth' | 'items' | 'nodes';
}

export interface AtResult {
  spec: string;
  offset: number;
  error?: string;
  /** Path of the field, e.g. `png/chunks/[3]/len`. */
  path?: string;
  /** Root to field, without array buckets. */
  chain?: { name: string; type?: string; range?: [number, number] }[];
  node?: JsonNode;
  note?: string;
}

export interface Problem {
  source: 'yaml' | 'kaitai';
  message: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  /** YAML path the compiler reported. */
  path?: string;
  /** Imported spec the error is in. */
  file?: string;
  /** Close matches for an unknown type or enum. */
  suggestions?: string[];
}

export interface ValidateResult {
  spec: string;
  id?: string;
  ok: boolean;
  errors: Problem[];
  warnings: Problem[];
}

const DEFAULTS: Required<Limits> = { depth: 3, maxItems: 20, maxNodes: 400, maxBytes: 32, maxString: 200 };
export const UNLIMITED: Required<Limits> = {
  depth: Number.POSITIVE_INFINITY,
  maxItems: Number.POSITIVE_INFINITY,
  maxNodes: Number.POSITIVE_INFINITY,
  maxBytes: Number.POSITIVE_INFINITY,
  maxString: Number.POSITIVE_INFINITY,
};
const MAX_FILE_BYTES = Number(process.env.KAITAI_MAX_FILE_MB || 256) * 1024 * 1024;
const MAX_CANDIDATES = 8;

// ---------------------------------------------------------------------------------------------
// Caches (the MCP server is long-lived; compiling is the slow part)

class Lru<V> {
  private readonly map = new Map<string, V>();
  private readonly size: number;
  constructor(size: number) {
    this.size = size;
  }
  get(key: string) {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, v: V) {
    this.map.delete(key);
    this.map.set(key, v);
    while (this.map.size > this.size) this.map.delete(this.map.keys().next().value as string);
  }
  delete(key: string) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
}

const templates = new Lru<Promise<Template>>(16);
const parses = new Lru<ParseResult>(4);
let templateIds = new WeakMap<Template, number>();
let nextTemplateId = 0;

const hash = (...parts: string[]) => createHash('sha256').update(parts.join('\0')).digest('hex');

export class Kaitai {
  readonly loader: SpecLoader;
  constructor(opts: SourceOptions = {}) {
    this.loader = new SpecLoader(opts);
  }

  async loadSpec(input: SpecInput): Promise<LoadedSpec> {
    if ((input.spec === undefined) === (input.source === undefined)) {
      throw new Error('Give either a spec (file path or gallery:<path>) or inline spec source');
    }
    return input.source !== undefined ? this.loader.inline(input.source) : this.loader.load(input.spec as string);
  }

  /** Compiles a spec, cached by source. Imports are not part of the key; a changed import needs a new process. */
  private template(spec: LoadedSpec): Promise<Template> {
    const key = hash(this.loader.repo, this.loader.ref, spec.label, spec.source);
    let t = templates.get(key);
    if (!t) {
      t = compileTemplate(spec.source, spec.readImport);
      t.catch(() => templates.delete(key));
      templates.set(key, t);
    }
    return t;
  }

  private async parseFile(input: ParseInput) {
    const spec = await this.loadSpec(input);
    const template = await this.template(spec).catch((e) => {
      throw new Error(`Spec ${spec.label} does not compile: ${describeKsyError(e)}`);
    });
    const info = await stat(input.file);
    if (!info.isFile()) throw new Error(`${input.file} is not a file`);
    if (info.size > MAX_FILE_BYTES) {
      throw new Error(`${input.file} is ${info.size} bytes; the limit is ${MAX_FILE_BYTES} (KAITAI_MAX_FILE_MB)`);
    }
    const params = (input.params ?? []).map((p, i) => {
      if (typeof p !== 'string') return p;
      const v = parseParamValue(p, template.params[i]?.type);
      if (v === INVALID) throw new Error(`Bad value for param ${template.params[i]?.id ?? i}: ${p}`);
      return v;
    });
    if (!templateIds.has(template)) templateIds.set(template, nextTemplateId++);
    const key = hash(
      String(templateIds.get(template)),
      input.file,
      String(info.mtimeMs),
      String(info.size),
      input.typeName ?? '',
      JSON.stringify(params, (_, v) => (typeof v === 'bigint' ? `${v}n` : v instanceof Uint8Array ? [...v] : v)),
    );
    let result = parses.get(key);
    if (!result) {
      const buf = await readFile(input.file);
      result = template.parse(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), {
        params,
        typeName: input.typeName,
      });
      parses.set(key, result);
    }
    return { spec, template, result, size: info.size };
  }

  /** Parses a file and returns (part of) the tree. */
  async parse(input: ParseInput) {
    const { spec, template, result, size } = await this.parseFile(input);
    const limits = { ...DEFAULTS, ...definedOnly(input) };
    const root = result.roots[0];
    const out = {
      spec: spec.label,
      id: template.id,
      fileSize: size,
      ...(result.error && { error: result.error }),
      tree: undefined as JsonNode | undefined,
    };
    if (!root) return out;
    const start = input.path ? resolvePath(root, input.path) : root;
    const budget = { nodes: limits.maxNodes };
    out.tree = serialize(start, limits, limits.depth, budget, !input.noInstances, input.from ?? 0);
    return out;
  }

  /** The field at a file offset, with the chain of structs containing it. */
  async at(input: ParseInput & { offset: number }): Promise<AtResult> {
    const { spec, result, size } = await this.parseFile(input);
    if (!Number.isInteger(input.offset) || input.offset < 0 || input.offset >= size) {
      throw new Error(`Offset ${input.offset} is outside the file (0..${size - 1})`);
    }
    const node = findDeepestNode(result.roots, input.offset);
    const limits = { ...DEFAULTS, depth: 1, ...definedOnly(input) };
    const chain: { name: string; type?: string; range?: [number, number] }[] = [];
    for (let n = node; n; n = n.parent) {
      if (n.kind !== 'bucket') chain.unshift({ name: n.name, type: n.type, range: rangeOf(n) });
    }
    const out: AtResult = { spec: spec.label, offset: input.offset };
    if (result.error) out.error = result.error;
    if (!node) out.note = 'No parsed field covers this offset';
    else {
      out.path = pathOf(node);
      out.chain = chain;
      out.node = serialize(node, limits, limits.depth, { nodes: limits.maxNodes }, false, 0);
    }
    return out;
  }

  /** Checks a spec: YAML syntax, then the compiler. Errors carry 1-based line/column. */
  async validate(input: SpecInput): Promise<ValidateResult> {
    const spec = await this.loadSpec(input);
    const parsed = parseKsyDocument(spec.source);
    const at = (start: number, end: number) => {
      const s = parsed.lines.linePos(start);
      const e = parsed.lines.linePos(Math.max(end, start + 1));
      return { line: s.line, column: s.col, endLine: e.line, endColumn: e.col };
    };
    const yaml = (e: { pos: [number, number]; message: string }): Problem => ({
      source: 'yaml',
      message: e.message.split('\n')[0],
      ...at(e.pos[0], e.pos[1]),
    });
    const errors = parsed.doc.errors.map(yaml);
    const warnings = parsed.doc.warnings.map(yaml);
    if (!errors.length) {
      const imported: string[] = [];
      const readImport = async (name: string, mode: 'rel' | 'abs') => {
        const text = await spec.readImport(name, mode);
        imported.push(text);
        return text;
      };
      try {
        await generateCode(spec.source, 'javascript', readImport, true);
      } catch (e) {
        const err = e instanceof KsyError ? e : new KsyError(describeKsyError(e));
        const ownId = parsed.root.specId || undefined;
        const target = diagnosticTargetPath(parsed, err, ownId);
        const r = rangeForPath(parsed, spec.source, target);
        const isImported = isImportedError(err, ownId);
        const unresolved = isImported ? undefined : unresolvedName(err.message);
        const roots: TypeInfo[] = imported.map((t) => parseKsyDocument(t).root);
        const suggestions = unresolved
          ? suggestionsFor(parsed, target, unresolved.what, unresolved.name, roots)
          : undefined;
        const problem: Problem = { source: 'kaitai', message: err.message, ...at(r.start, r.end) };
        if (err.path?.length) problem.path = `/${err.path.join('/')}`;
        if (isImported) problem.file = err.file;
        if (suggestions?.length) problem.suggestions = suggestions;
        errors.push(problem);
      }
    }
    return { spec: spec.label, id: parsed.root.specId || undefined, ok: !errors.length, errors, warnings };
  }

  /**
   * Gallery specs for a file, from its extension. With `tryParse`, each candidate is compiled and run on the file,
   * and the candidates are ranked by whether they parse and how much of the file their top-level fields cover.
   */
  async suggest(input: { file: string; tryParse?: boolean }) {
    const ext = extensionOf(input.file);
    const paths = suggestFor(ext, []).slice(0, MAX_CANDIDATES);
    const candidates: { spec: string; ok?: boolean; coverage?: number; error?: string }[] = paths.map((p) => ({
      spec: `gallery:${p}`,
    }));
    if (input.tryParse) {
      for (const c of candidates) {
        try {
          const { result, size } = await this.parseFile({ spec: c.spec, file: input.file });
          c.ok = !result.error;
          if (result.error) c.error = result.error;
          c.coverage = coverage(result.roots[0], size);
        } catch (e) {
          c.ok = false;
          c.error = (e as Error).message;
        }
      }
      candidates.sort((a, b) => Number(b.ok) - Number(a.ok) || (b.coverage ?? 0) - (a.coverage ?? 0));
    }
    return {
      file: input.file,
      extension: ext,
      repo: `${this.loader.repo}@${this.loader.ref}`,
      candidates,
      ...(!candidates.length && {
        note: 'No gallery spec lists this file extension. Write a spec, or try gallery specs by hand.',
      }),
    };
  }

  /** Generates parser source code in another language. */
  async compile(input: SpecInput & { language: string; maxChars?: number }) {
    if (!LANGUAGES.includes(input.language)) {
      throw new Error(`Unknown language ${input.language}; one of ${LANGUAGES.join(', ')}`);
    }
    const spec = await this.loadSpec(input);
    const files = await generateCode(spec.source, input.language, spec.readImport).catch((e) => {
      throw new Error(`Spec ${spec.label} does not compile: ${describeKsyError(e)}`);
    });
    let budget = input.maxChars ?? Number.POSITIVE_INFINITY;
    const out: Record<string, string> = {};
    let truncated = false;
    for (const [name, code] of Object.entries(files)) {
      if (budget <= 0) {
        truncated = true;
        break;
      }
      out[name] = code.length > budget ? `${code.slice(0, budget)}\n… (cut)` : code;
      truncated ||= code.length > budget;
      budget -= code.length;
    }
    return { spec: spec.label, language: input.language, files: out, ...(truncated && { truncated: true }) };
  }
}

/** Test hook: forget compiled specs and parse results. */
export function clearCaches() {
  templates.clear();
  parses.clear();
  templateIds = new WeakMap();
}

function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function describeKsyError(e: unknown): string {
  if (e instanceof KsyError) {
    const where = e.path?.length ? ` at /${e.path.join('/')}` : '';
    return `${e.file ? `${e.file}.ksy` : ''}${where}${e.file || where ? ': ' : ''}${e.message}`;
  }
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------------------------
// Tree helpers

const rangeOf = (n: StructureNode): [number, number] | undefined =>
  n.range ? [n.range.start, n.range.end] : undefined;

/** Item count of an array node (the engine renders it as `[n]`). */
function arrayLength(node: StructureNode): number {
  const m = /^\[(\d+)\]$/.exec(node.value ?? '');
  return m ? Number(m[1]) : 0;
}

/** Items `from..to` of an array node, descending only into the buckets that overlap. */
function arraySlice(node: StructureNode, from: number, to: number): StructureNode[] {
  const out: StructureNode[] = [];
  const walk = (children: StructureNode[]) => {
    for (const c of children) {
      if (c.kind === 'bucket') {
        const m = /^\[(\d+)\.\.(\d+)\]$/.exec(c.name);
        if (m && Number(m[2]) >= from && Number(m[1]) < to) walk(c.children());
        continue;
      }
      const i = Number(/^\[(\d+)\]$/.exec(c.name)?.[1]);
      if (i >= from && i < to) out.push(c);
    }
  };
  walk(node.children());
  return out;
}

/** Path without bucket segments, e.g. `png/chunks/[3]/len`. */
export function pathOf(node: StructureNode): string {
  const parts: string[] = [];
  for (let n: StructureNode | undefined = node; n; n = n.parent) if (n.kind !== 'bucket') parts.unshift(n.name);
  return parts.join('/');
}

/** Finds a node by path: `a/b/[3]/c`, `a/b/3/c` or `a.b[3].c`. The root's name may be left out. */
export function resolvePath(root: StructureNode, path: string): StructureNode {
  const parts = path
    .replace(/\[(\d+)\]/g, '/$1')
    .split(/[/.]/)
    .filter(Boolean);
  if (parts[0] === root.name) parts.shift();
  let node = root;
  for (const [i, part] of parts.entries()) {
    let next: StructureNode | undefined;
    if (node.kind === 'array' && /^\d+$/.test(part)) next = arraySlice(node, Number(part), Number(part) + 1)[0];
    else if (node.kind === 'struct') next = node.children().find((c) => c.name === part);
    if (!next) {
      const at = [root.name, ...parts.slice(0, i)].join('/');
      const options =
        node.kind === 'struct'
          ? `fields: ${node
              .children()
              .map((c) => c.name)
              .join(', ')}`
          : node.kind === 'array'
            ? `indices 0..${arrayLength(node) - 1}`
            : 'no children';
      throw new Error(`No "${part}" in ${at} (${node.kind}; ${options})`);
    }
    node = next;
  }
  return node;
}

function leafValue(node: StructureNode, limits: Required<Limits>): Pick<JsonNode, 'value' | 'size' | 'enum'> {
  const v = node.raw;
  if (v instanceof Uint8Array) {
    const shown = v.subarray(0, Math.min(v.length, limits.maxBytes));
    const hex = Array.from(shown, (b) => b.toString(16).padStart(2, '0')).join(' ');
    return { value: hex, ...(shown.length < v.length && { size: v.length }) };
  }
  if (typeof v === 'string') {
    return v.length > limits.maxString ? { value: `${v.slice(0, limits.maxString)}…`, size: v.length } : { value: v };
  }
  if (typeof v === 'bigint') return { value: Number.isSafeInteger(Number(v)) ? Number(v) : v.toString() };
  if (node.kind === 'enum') {
    // The engine renders enums as `label = 1 (0x1)`.
    const label = /^(\S+) = /.exec(node.value ?? '')?.[1];
    return { value: v as number, ...(label && { enum: label }) };
  }
  return { value: v ?? null };
}

function serialize(
  node: StructureNode,
  limits: Required<Limits>,
  depth: number,
  budget: { nodes: number },
  instances: boolean,
  from: number,
): JsonNode {
  budget.nodes--;
  const out: JsonNode = { name: node.name, kind: node.kind };
  if (node.type) out.type = node.type;
  const r = rangeOf(node);
  if (r) out.range = r;
  if (node.instance) out.instance = true;
  if (node.error) out.error = node.error;

  if (node.kind === 'struct') {
    if (node.value) out.summary = node.value;
    if (depth <= 0) {
      out.truncated = 'depth';
      return out;
    }
    out.fields = [];
    for (const c of node.children()) {
      if (c.instance && !instances) continue;
      if (budget.nodes <= 0) {
        out.truncated = 'nodes';
        break;
      }
      out.fields.push(serialize(c, limits, depth - 1, budget, instances, 0));
    }
    return out;
  }
  if (node.kind === 'array') {
    const count = arrayLength(node);
    out.count = count;
    if (depth <= 0) {
      if (count) out.truncated = 'depth';
      return out;
    }
    const start = Math.min(Math.max(0, from), count);
    const end = Math.min(count, start + limits.maxItems);
    if (start) out.from = start;
    out.items = [];
    for (const c of arraySlice(node, start, end)) {
      if (budget.nodes <= 0) {
        out.truncated = 'nodes';
        break;
      }
      out.items.push(serialize(c, limits, depth - 1, budget, instances, 0));
    }
    if (!out.truncated && (end < count || start > 0)) out.truncated = 'items';
    return out;
  }
  if (node.kind === 'bucket') return out;
  return Object.assign(out, leafValue(node, limits));
}

/** Share of the file covered by the root's top-level seq fields, 0..1. */
function coverage(root: StructureNode | undefined, size: number): number {
  if (!root || !size) return 0;
  let covered = 0;
  for (const c of root.children()) if (!c.instance && c.range) covered += c.range.end - c.range.start;
  return Math.round((Math.min(covered, size) / size) * 1000) / 1000;
}
