// The operations behind the `kaitai` CLI and MCP server: parse, at, validate, suggest and compile. Results are plain
// JSON with size caps, so they can go straight into an agent's context. No vscode import.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import {
  compileTemplate,
  generateCode,
  type ImportReader,
  KsyError,
  LANGUAGES,
  type Template,
} from '../engine/kaitai.ts';
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
  /** Characters of a string or struct summary to show. */
  maxString?: number;
}

export interface ParseInput extends SpecInput, Limits {
  file: string;
  /** Node path such as `png/chunks/[3]/body` or `chunks[3].body`. Defaults to the root. */
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

export interface ParseOutput {
  spec: string;
  id: string;
  fileSize: number;
  /** Set when parsing stopped early. The tree is still usable up to that point. */
  error?: string;
  /** Path of `tree`, for drilling down: append `/<field>` or `/[<index>]`. */
  path?: string;
  tree?: JsonNode;
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
const MAX_FILE_BYTES = (Number(process.env.KAITAI_MAX_FILE_MB) || 256) * 1024 * 1024;
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
    if (v !== undefined) this.set(key, v);
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
}

interface Compiled {
  /** Distinguishes compilations of one spec in parse cache keys. */
  id: number;
  template: Promise<Template>;
  /** Every import read, in order. */
  imports: { name: string; mode: 'rel' | 'abs'; text: string }[];
}

const hash = (...parts: string[]) => createHash('sha256').update(parts.join('\0')).digest('hex');

export class Kaitai {
  readonly loader: SpecLoader;
  private readonly templates = new Lru<Compiled>(16);
  private readonly parses = new Lru<ParseResult>(4);
  private compilations = 0;

  constructor(opts: SourceOptions = {}) {
    this.loader = new SpecLoader(opts);
  }

  async loadSpec(input: SpecInput): Promise<LoadedSpec> {
    if ((input.spec === undefined) === (input.source === undefined)) {
      throw new Error('Give either a spec (file path or gallery:<path>) or inline spec source');
    }
    return input.source !== undefined ? this.loader.inline(input.source) : this.loader.load(input.spec as string);
  }

  /** Compiles a spec, cached by its source and the sources of its imports. */
  private async compiled(spec: LoadedSpec): Promise<Compiled> {
    const key = hash(spec.label, spec.source);
    let c = this.templates.get(key);
    if (c) {
      // Replaying the imports in order resolves them like the first time (the reader tracks folders seen).
      for (const { name, mode, text } of c.imports) {
        if ((await spec.readImport(name, mode).catch(() => undefined)) === text) continue;
        c = undefined;
        break;
      }
    }
    if (!c) {
      const imports: Compiled['imports'] = [];
      const readImport: ImportReader = async (name, mode) => {
        const text = await spec.readImport(name, mode);
        imports.push({ name, mode, text });
        return text;
      };
      const made: Compiled = { id: this.compilations++, template: compileTemplate(spec.source, readImport), imports };
      // Failures are not kept: a missing import may turn up.
      made.template.catch(() => this.templates.get(key) === made && this.templates.delete(key));
      this.templates.set(key, made);
      c = made;
    }
    return c;
  }

  private async parseFile(input: ParseInput) {
    const info = await fileInfo(input.file);
    const spec = await this.loadSpec(input);
    const compiled = await this.compiled(spec);
    const template = await compiled.template.catch((e) => {
      throw new Error(`Spec ${spec.label} does not compile: ${describeKsyError(e)}`);
    });
    const params = (input.params ?? []).map((p, i) => {
      if (typeof p !== 'string') return p;
      const v = parseParamValue(p, template.params[i]?.type);
      if (v === INVALID) throw new Error(`Bad value for param ${template.params[i]?.id ?? i}: ${p}`);
      return v;
    });
    const key = hash(
      String(compiled.id),
      input.file,
      String(info.mtimeMs),
      String(info.size),
      input.typeName ?? '',
      JSON.stringify(params, (_, v) => (typeof v === 'bigint' ? `${v}n` : v instanceof Uint8Array ? [...v] : v)),
    );
    let result = this.parses.get(key);
    if (!result) {
      const buf = await readFile(input.file);
      result = template.parse(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), {
        params,
        typeName: input.typeName,
      });
      this.parses.set(key, result);
    }
    return { spec, template, result, size: info.size };
  }

  /** Parses a file and returns (part of) the tree. */
  async parse(input: ParseInput): Promise<ParseOutput> {
    const { spec, template, result, size } = await this.parseFile(input);
    const limits = limitsOf(input);
    const root = result.roots[0];
    const out: ParseOutput = { spec: spec.label, id: template.id, fileSize: size };
    if (result.error) out.error = result.error;
    if (!root) return out;
    let start = root;
    try {
      if (input.path) start = resolvePath(root, input.path);
    } catch (e) {
      // A field may be missing because parsing stopped before it.
      throw result.error ? new Error(`${(e as Error).message}. Parsing stopped early: ${result.error}`) : e;
    }
    out.path = pathOf(start);
    out.tree = serialize(
      start,
      { limits, nodes: limits.maxNodes, instances: !input.noInstances },
      limits.depth,
      input.from,
    );
    return out;
  }

  /** The field at a file offset, with the chain of structs containing it. */
  async at(input: ParseInput & { offset: number }): Promise<AtResult> {
    const { spec, result, size } = await this.parseFile(input);
    if (!Number.isInteger(input.offset) || input.offset < 0 || input.offset >= size) {
      throw new Error(`Offset ${input.offset} is outside the file (0..${size - 1})`);
    }
    let node = findDeepestNode(result.roots, input.offset);
    // A bucket is the deepest node for a gap between array items; report the array.
    while (node?.kind === 'bucket') node = node.parent;
    const limits = limitsOf({ ...input, depth: input.depth ?? 1 });
    const out: AtResult = { spec: spec.label, offset: input.offset };
    if (result.error) out.error = result.error;
    if (!node) out.note = 'No parsed field covers this offset';
    else {
      out.path = pathOf(node);
      out.chain = [];
      for (let n: StructureNode | undefined = node; n; n = n.parent) {
        if (n.kind !== 'bucket') out.chain.unshift({ name: n.name, type: n.type, range: rangeOf(n) });
      }
      out.node = serialize(node, { limits, nodes: limits.maxNodes, instances: false }, limits.depth);
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
      const readImport: ImportReader = async (name, mode) => {
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
      await fileInfo(input.file);
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

function limitsOf(l: Limits): Required<Limits> {
  return {
    depth: l.depth ?? DEFAULTS.depth,
    maxItems: l.maxItems ?? DEFAULTS.maxItems,
    maxNodes: l.maxNodes ?? DEFAULTS.maxNodes,
    maxBytes: l.maxBytes ?? DEFAULTS.maxBytes,
    maxString: l.maxString ?? DEFAULTS.maxString,
  };
}

/** Checks that `file` can be parsed, before any slow work. */
async function fileInfo(file: string) {
  const info = await stat(file).catch((e: NodeJS.ErrnoException) => {
    throw new Error(`Cannot read ${file}: ${e.code ?? e.message}`);
  });
  if (!info.isFile()) throw new Error(`${file} is not a file`);
  if (info.size > MAX_FILE_BYTES) {
    throw new Error(`${file} is ${info.size} bytes; the limit is ${MAX_FILE_BYTES} (KAITAI_MAX_FILE_MB)`);
  }
  return info;
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
function pathOf(node: StructureNode): string {
  const parts: string[] = [];
  for (let n: StructureNode | undefined = node; n; n = n.parent) if (n.kind !== 'bucket') parts.unshift(n.name);
  return parts.join('/');
}

/**
 * Finds a node by path: `a/b/[3]/c`, `a/b/3/c` or `a.b[3].c`. The root's name may be left out; a leading segment
 * equal to it is always the root, so that paths from {@link pathOf} round-trip.
 */
function resolvePath(root: StructureNode, path: string): StructureNode {
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
            ? arrayLength(node)
              ? `indices 0..${arrayLength(node) - 1}`
              : 'empty'
            : 'no children';
      throw new Error(`No "${part}" in ${at} (${node.kind}; ${options})`);
    }
    node = next;
  }
  return node;
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

function leafValue(node: StructureNode, limits: Required<Limits>): Pick<JsonNode, 'value' | 'size' | 'enum'> {
  const v = node.raw;
  if (v instanceof Uint8Array) {
    const shown = v.subarray(0, Math.min(v.length, limits.maxBytes));
    const hex = Array.from(shown, (b) => b.toString(16).padStart(2, '0')).join(' ');
    return { value: hex, ...(shown.length < v.length && { size: v.length }) };
  }
  if (typeof v === 'string') {
    return { value: clip(v, limits.maxString), ...(v.length > limits.maxString && { size: v.length }) };
  }
  // JSON has no bigint, NaN or Infinity.
  const value =
    typeof v === 'bigint'
      ? Number.isSafeInteger(Number(v))
        ? Number(v)
        : v.toString()
      : typeof v === 'number' && !Number.isFinite(v)
        ? String(v)
        : (v ?? null);
  // The engine renders enums as `label = 1 (0x1)`.
  const label = node.kind === 'enum' ? /^(\S+) = /.exec(node.value ?? '')?.[1] : undefined;
  return { value, ...(label && { enum: label }) };
}

interface Output {
  limits: Required<Limits>;
  /** Nodes left in the output budget. */
  nodes: number;
  instances: boolean;
}

/** `depth` is the levels left below `node`; `from` the first item to show when it is an array. */
function serialize(node: StructureNode, o: Output, depth: number, from = 0): JsonNode {
  o.nodes--;
  const out: JsonNode = { name: node.name, kind: node.kind };
  if (node.type) out.type = node.type;
  const r = rangeOf(node);
  if (r) out.range = r;
  if (node.instance) out.instance = true;
  if (node.error) out.error = node.error;

  const children = (list: StructureNode[]) => {
    const kids: JsonNode[] = [];
    for (const c of list) {
      if (o.nodes <= 0) {
        out.truncated = 'nodes';
        break;
      }
      kids.push(serialize(c, o, depth - 1));
    }
    return kids;
  };

  if (node.kind === 'struct') {
    if (node.value) out.summary = clip(node.value, o.limits.maxString);
    if (depth <= 0) out.truncated = 'depth';
    else out.fields = children(node.children().filter((c) => o.instances || !c.instance));
  } else if (node.kind === 'array') {
    const count = arrayLength(node);
    out.count = count;
    if (depth <= 0) {
      if (count) out.truncated = 'depth';
      return out;
    }
    const start = Math.min(Math.max(0, from), count);
    const end = Math.min(count, start + o.limits.maxItems);
    if (start) out.from = start;
    out.items = children(arraySlice(node, start, end));
    if (!out.truncated && (end < count || start > 0)) out.truncated = 'items';
  } else Object.assign(out, leafValue(node, o.limits));
  return out;
}

/** Share of the file covered by the root's top-level seq fields, 0..1. */
function coverage(root: StructureNode | undefined, size: number): number {
  if (!root || !size) return 0;
  let covered = 0;
  for (const c of root.children()) if (!c.instance && c.range) covered += c.range.end - c.range.start;
  return Math.round((Math.min(covered, size) / size) * 1000) / 1000;
}
