// Generates a Wireshark Lua dissector from a .ksy spec.
//
// Pure ESM with no Node APIs, so the VS Code extension can bundle it for vscode.dev. The caller passes its own
// kaitai-struct-compiler (0.11+) rather than this module bundling a second copy.

import { GLUE, RUNTIME } from './lua-sources.generated.ts';
import { buildSchema, type Ksy, resolveType } from './schema.ts';

export interface Importer {
  importYaml(name: string, mode: string): Promise<Ksy>;
}

export interface Compiler {
  compile(lang: string, spec: Ksy, importer: Importer | null, debug: boolean): Promise<Record<string, string>>;
}

export interface Options {
  /** The parsed .ksy (not YAML text). */
  ksy: Ksy;
  /** The kaitai-struct-compiler module object. */
  compiler: Compiler;
  /** Loads imported specs; required when the spec has meta.imports. */
  importer?: Importer;
  /** Path or URI of the .ksy, for "Open in Kaitai IDE". */
  ksyUri?: string;
}

export interface Result {
  /** File name for the dissector: <meta.id>.lua */
  name: string;
  lua: string;
  warnings: string[];
}

// meta["-wireshark"]: how the dissector attaches to traffic.
interface WiresharkMeta {
  name?: string;
  'tcp-port'?: number | string | number[];
  'udp-port'?: number | string | number[];
  pdu?: string;
  'first-pdu'?: string;
  'user-dlt'?: number;
  heuristic?: string | string[];
}

function ports(p: WiresharkMeta['tcp-port']): string | undefined {
  if (p === undefined) return undefined;
  return Array.isArray(p) ? p.join(',') : String(p);
}

// Lua long bracket that doesn't occur in s.
function longString(s: string): string {
  let eq = '';
  while (s.includes(`]${eq}]`)) eq += '=';
  // a newline straight after the opening bracket is dropped, so one that starts s needs another
  return `[${eq}[\n${s}]${eq}]`;
}

function toLua(v: unknown, indent = ''): string {
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'string') return JSON.stringify(v).replace(/\\u([0-9a-f]{4})/gi, (_, h) => `\\u{${h}}`);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const inner = `${indent}  `;
  if (Array.isArray(v)) return `{ ${v.map((x) => toLua(x, inner)).join(', ')} }`;
  const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
  if (entries.length === 0) return '{}';
  return `{\n${entries.map(([k, x]) => `${inner}[${JSON.stringify(k)}] = ${toLua(x, inner)},`).join('\n')}\n${indent}}`;
}

// A heuristic dissector is only worth offering when the spec starts with a magic.
function startsWithMagic(spec: Ksy): boolean {
  const first = spec.seq?.[0];
  return first !== undefined && (first.contents !== undefined || first.valid !== undefined);
}

export async function generateDissector({ ksy, compiler, importer, ksyUri }: Options): Promise<Result> {
  const warnings: string[] = [];
  const root: string = ksy.meta?.id;
  if (!root) throw new Error('meta.id is required');

  // record every imported spec as the compiler loads it, for the schema
  const imported: Ksy[] = [];
  const recording: Importer | null = importer
    ? {
        async importYaml(name, mode) {
          const spec = await importer.importYaml(name, mode);
          imported.push(spec);
          return spec;
        },
      }
    : null;
  const compiled = await compiler.compile('lua', ksy, recording, false);

  const seen = new Set<string>();
  const specs = [ksy, ...imported].filter((s) => !seen.has(s.meta.id) && seen.add(s.meta.id));
  const schema = buildSchema(specs);

  const ws: WiresharkMeta = ksy.meta['-wireshark'] ?? {};
  let heuristic = ws.heuristic === undefined ? [] : [ws.heuristic].flat();
  if (heuristic.length > 0 && !startsWithMagic(ksy)) {
    warnings.push('-wireshark.heuristic ignored: the first seq field has no contents or valid to check');
    heuristic = [];
  }
  const tcp = ports(ws['tcp-port']);
  const last = ksy.seq?.at(-1);
  if (tcp && !ws.pdu && last?.repeat === 'eos') {
    warnings.push(
      `TCP framing: each segment parses as a whole ${root}, so a ${last.id} split across segments reassembles ` +
        `from the start of ${root}. Set -wireshark.pdu (and first-pdu for a header) to frame records.`,
    );
  }

  const spec = {
    name: ws.name ?? root,
    title: ksy.meta.title ?? root,
    root,
    pdu: ws.pdu && resolveType(schema, root, ws.pdu),
    first_pdu: ws['first-pdu'] && resolveType(schema, root, ws['first-pdu']),
    ksy: ksyUri,
    wireshark: {
      tcp_ports: tcp,
      udp_ports: ports(ws['udp-port']),
      user_dlt: ws['user-dlt'],
      heuristic,
    },
    types: schema.types,
    enums: schema.enums,
  };

  const modules: Record<string, string> = { ...RUNTIME };
  for (const [file, src] of Object.entries(compiled)) modules[file.replace(/\.lua$/, '')] = src;

  const lua = [
    `-- Wireshark dissector for ${spec.title}, generated from ${root}.ksy by kaitai-wireshark. Do not edit.`,
    '-- Load with: wireshark -X lua_script:<this file>, or copy it to the personal Lua plugins folder.',
    '-- Needs Wireshark 4.4 or later (Lua 5.4).',
    '',
    'local MODULES = {',
    ...Object.entries(modules).map(([name, src]) => `[${JSON.stringify(name)}] = ${longString(src)},`),
    '}',
    '',
    `local SPEC = ${toLua(spec)}`,
    '',
    GLUE,
  ].join('\n');

  return { name: `${root}.lua`, lua, warnings };
}
