// Generates a Wireshark Lua dissector from a .ksy spec: the Kaitai Lua runtime, the spec compiled to Lua, the spec
// itself as a Lua table, and the glue (src/lua/glue.lua) that derives Wireshark fields from the spec and traces the
// parser to build the tree.
//
// Pure ESM with no Node APIs, so the VS Code extension can bundle it for vscode.dev. The caller passes its own
// kaitai-struct-compiler (0.11+) rather than this module bundling a second copy.

import { GLUE, RUNTIME, RUNTIME_LICENSE } from './lua-sources.generated.ts';

// biome-ignore lint/suspicious/noExplicitAny: .ksy is untyped YAML
export type Ksy = Record<string, any>;

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

/** A JSON-like value as a Lua expression. Integer keys stay integers (enum values); null is nil. */
export function toLua(v: unknown): string {
  if (v === null || v === undefined) return 'nil';
  // JSON's string escapes are also Lua's, except \uXXXX. Matching "\\" too keeps an escaped backslash before a "u".
  if (typeof v === 'string')
    return JSON.stringify(v).replace(/\\(\\|u([0-9a-f]{4}))/g, (m, _, hex) => (hex ? `\\u{${hex}}` : m));
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) return `{${v.map(toLua).join(', ')}}`;
  const entries = Object.entries(v).filter(([, x]) => x !== null && x !== undefined);
  return `{${entries.map(([k, x]) => `[${/^-?\d+$/.test(k) ? k : toLua(k)}] = ${toLua(x)}`).join(', ')}}`;
}

export async function generateDissector({ ksy, compiler, importer, ksyUri }: Options): Promise<Result> {
  const id: string = ksy.meta?.id;
  if (!id) throw new Error('meta.id is required');

  // the glue needs every imported spec too, so record them as the compiler loads them
  const specs = [ksy];
  const recording: Importer | null = importer
    ? {
        async importYaml(name, mode) {
          specs.push(await importer.importYaml(name, mode));
          return specs.at(-1) as Ksy;
        },
      }
    : null;
  const compiled = await compiler.compile('lua', ksy, recording, false);
  const modules = { ...RUNTIME };
  for (const [file, src] of Object.entries(compiled)) modules[file.replace(/\.lua$/, '')] = src;

  const warnings: string[] = [];
  const ws = ksy.meta['-wireshark'] ?? {};
  const last = ksy.seq?.at(-1);
  if (ws['tcp-port'] !== undefined && !ws.pdu && last?.repeat === 'eos') {
    warnings.push(
      `TCP framing: each segment parses as a whole ${id}, so a ${last.id} split across segments reassembles from ` +
        `the start of ${id}. Set -wireshark.pdu (and first-pdu for a header) to frame records.`,
    );
  }

  const lua = [
    `-- Wireshark dissector for ${ksy.meta.title ?? id}, generated from ${id}.ksy by kaitai-wireshark. Do not edit.`,
    '-- Load with: wireshark -X lua_script:<this file>, or copy it to the personal Lua plugins folder.',
    '-- Needs Wireshark 4.4 or later (Lua 5.4).',
    RUNTIME_LICENSE,
    `local MODULES = ${toLua(modules)}`,
    `local SPECS = ${toLua(specs)}`,
    `local KSY = ${toLua(ksyUri ?? '')}`,
    GLUE,
  ].join('\n');
  return { name: `${id}.lua`, lua, warnings };
}
