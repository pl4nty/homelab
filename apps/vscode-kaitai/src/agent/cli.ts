// `kaitai` command line: parse, at, validate, suggest and compile, plus `mcp` to run the MCP server on stdio.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { parseUint } from '../util/parse.ts';
import { type JsonNode, Kaitai, LANGUAGES, type Limits, UNLIMITED, type ValidateResult } from './ops.ts';
import type { SourceOptions } from './source.ts';
import { VERSION } from './version.ts';

const USAGE = `kaitai ${VERSION}: parse binary files with Kaitai Struct specs (no Java or ksc needed)

Usage:
  kaitai parse <spec> <file> [--path P] [--from N] [--depth N] [--max-items N] [--type T] [--param V]...
  kaitai at <spec> <file> <offset>        field at a file offset (decimal or 0x hex)
  kaitai validate <spec>...               YAML and compiler errors with line/column; exit 1 on errors
  kaitai suggest <file> [--try]           gallery specs for the file's extension; --try parses each and ranks them
  kaitai compile <spec> -l <lang> [-o D]  generate parser code (${LANGUAGES.join(', ')})
  kaitai mcp                              run the MCP server on stdio

<spec> is a .ksy path, gallery:<path> (e.g. gallery:image/png) from the format gallery, or - for stdin.

Options:
  --json                 machine-readable output
  --all                  no output limits (parse, at)
  --no-instances         leave out instances (parse)
  -I, --import-path D    extra folder for imports (repeatable; also KSPATH)
  --repo owner/repo      format gallery (default pl4nty/kaitai_struct_formats; KAITAI_FORMATS_REPO)
  --ref REF              gallery branch, tag or commit (default master; KAITAI_FORMATS_REF)
  --offline              never use the network (KAITAI_OFFLINE=1)
  -h, --help | -v, --version
`;

const CLI_LIMITS: Required<Limits> = { depth: 8, maxItems: 100, maxNodes: 5000, maxBytes: 32, maxString: 200 };

class UsageError extends Error {}

/** Where output goes (process.stdout/stderr, or a capture in tests). */
export interface Output {
  write(text: string): unknown;
}

export async function main(
  argv: string[],
  out: Output = process.stdout,
  err: Output = process.stderr,
): Promise<number> {
  let args: ReturnType<typeof parse>;
  try {
    args = parse(argv);
  } catch (e) {
    err.write(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const {
    values: o,
    positionals: [cmd, ...rest],
  } = args;
  if (o.version) {
    out.write(`${VERSION}\n`);
    return 0;
  }
  if (o.help || !cmd) {
    (o.help ? out : err).write(USAGE);
    return o.help ? 0 : 2;
  }
  const source: SourceOptions = {
    repo: o.repo,
    ref: o.ref,
    importPaths: o['import-path'],
    // Left unset without the flag, so that KAITAI_OFFLINE still applies.
    network: o.offline ? false : undefined,
  };
  if (cmd === 'mcp') {
    const { serve } = await import('./mcp.ts');
    await serve(source);
    return 0;
  }

  const k = new Kaitai(source);
  const print = (v: unknown, text: () => string) => out.write(o.json ? `${JSON.stringify(v, null, 2)}\n` : text());
  const int = (name: keyof typeof o) => {
    const v = o[name];
    if (v === undefined) return undefined;
    const n = parseUint(String(v));
    if (Number.isNaN(n)) throw new UsageError(`--${name} needs a number`);
    return n;
  };
  const spec = async (ref: string | undefined) => {
    if (!ref) throw new UsageError('Missing <spec>');
    return ref === '-' ? { source: await readStdin() } : { spec: ref };
  };
  const need = (v: string | undefined, what: string) => {
    if (!v) throw new UsageError(`Missing ${what}`);
    return v;
  };
  /** `depth` is the default without --depth and --all. */
  const limits = (depth = CLI_LIMITS.depth): Limits => {
    const base = o.all ? UNLIMITED : { ...CLI_LIMITS, depth };
    return { ...base, depth: int('depth') ?? base.depth, maxItems: int('max-items') ?? base.maxItems };
  };

  try {
    switch (cmd) {
      case 'parse': {
        const r = await k.parse({
          ...(await spec(rest[0])),
          file: need(rest[1], '<file>'),
          path: o.path,
          from: int('from'),
          typeName: o.type,
          params: o.param,
          noInstances: o['no-instances'],
          ...limits(),
        });
        print(r, () => (r.error ? `error: ${r.error}\n` : '') + (r.tree ? renderTree(r.tree) : ''));
        return r.error ? 1 : 0;
      }
      case 'at': {
        const offset = parseUint(need(rest[2], '<offset>'));
        if (Number.isNaN(offset)) throw new UsageError('<offset> must be a number (decimal or 0x hex)');
        const r = await k.at({
          ...(await spec(rest[0])),
          file: need(rest[1], '<file>'),
          offset,
          typeName: o.type,
          params: o.param,
          ...limits(1),
        });
        const chain = (r.chain ?? [])
          .slice(0, -1)
          .map((c) => `  ${c.name}${c.type ? `: ${c.type}` : ''} ${hexRange(c.range)}\n`);
        print(r, () => (r.node ? `${r.path}\n${chain.join('')}${renderTree(r.node)}` : `${r.error ?? r.note}\n`));
        return 0;
      }
      case 'validate': {
        if (!rest.length) throw new UsageError('Missing <spec>');
        let failed = false;
        const results: ValidateResult[] = [];
        for (const ref of rest) {
          const r = await k.validate(await spec(ref));
          failed ||= !r.ok;
          results.push(r);
        }
        print(results.length === 1 ? results[0] : results, () =>
          results
            .map((r) =>
              r.ok && !r.warnings.length
                ? `${r.spec}: ok\n`
                : [
                    ...r.errors.map((e) => ({ ...e, level: 'error' })),
                    ...r.warnings.map((w) => ({ ...w, level: 'warning' })),
                  ]
                    .map((e) => {
                      const where = e.file ? `in imported spec ${e.file}.ksy: ` : '';
                      const hint = e.suggestions ? ` (did you mean ${e.suggestions.join(', ')}?)` : '';
                      return `${r.spec}:${e.line}:${e.column}: ${e.level}: ${where}${e.message}${hint}\n`;
                    })
                    .join(''),
            )
            .join(''),
        );
        return failed ? 1 : 0;
      }
      case 'suggest': {
        const r = await k.suggest({ file: need(rest[0], '<file>'), tryParse: o.try });
        print(r, () =>
          r.candidates.length
            ? r.candidates
                .map((c) =>
                  c.ok === undefined
                    ? `${c.spec}\n`
                    : `${c.spec}  ${c.ok ? 'ok' : 'fails'}  coverage ${Math.round((c.coverage ?? 0) * 100)}%${c.error ? `  ${c.error}` : ''}\n`,
                )
                .join('')
            : `${r.note}\n`,
        );
        return 0;
      }
      case 'compile': {
        const r = await k.compile({ ...(await spec(rest[0])), language: need(o.lang, '--lang') });
        if (o.out) {
          for (const [name, code] of Object.entries(r.files)) {
            const path = join(o.out, name);
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, code);
            err.write(`${path}\n`);
          }
        } else if (o.json) print(r, () => '');
        else out.write(Object.values(r.files).join('\n'));
        return 0;
      }
      default:
        throw new UsageError(`Unknown command ${cmd}`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      err.write(`${e.message}\n\n${USAGE}`);
      return 2;
    }
    if (o.json) out.write(`${JSON.stringify({ error: (e as Error).message }, null, 2)}\n`);
    else err.write(`kaitai: ${(e as Error).message}\n`);
    return 1;
  }
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      all: { type: 'boolean' },
      path: { type: 'string' },
      from: { type: 'string' },
      depth: { type: 'string' },
      'max-items': { type: 'string' },
      type: { type: 'string' },
      param: { type: 'string', multiple: true },
      'no-instances': { type: 'boolean' },
      try: { type: 'boolean' },
      lang: { type: 'string', short: 'l' },
      out: { type: 'string', short: 'o' },
      'import-path': { type: 'string', short: 'I', multiple: true },
      repo: { type: 'string' },
      ref: { type: 'string' },
      offline: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const hex = (n: number) => `0x${n.toString(16)}`;
const hexRange = (r?: [number, number]) => (r ? `[${hex(r[0])}..${hex(r[1])})` : '');

/** Indented text tree: `name: type [0x0..0x4) = value`. */
export function renderTree(node: JsonNode, indent = ''): string {
  const head = [
    `${indent}${node.name}`,
    node.type ? `: ${node.type}` : '',
    node.range ? ` ${hexRange(node.range)}` : '',
    node.count !== undefined ? ` [${node.count}]` : '',
    node.summary ? ` ${node.summary}` : '',
    node.value !== undefined ? ` = ${node.enum ? `${node.enum} (${node.value})` : JSON.stringify(node.value)}` : '',
    node.size !== undefined ? ` (${node.size} total)` : '',
    node.instance ? ' (instance)' : '',
    node.error ? ` !! ${node.error}` : '',
  ].join('');
  const kids = node.fields ?? node.items ?? [];
  const more =
    node.truncated === 'items'
      ? `${indent}  … items ${node.from ?? 0}..${(node.from ?? 0) + kids.length - 1} of ${node.count} shown (--from, --max-items)\n`
      : node.truncated
        ? `${indent}  … (${node.truncated === 'depth' ? 'deeper levels: --depth or --path' : 'output limit: --path or --all'})\n`
        : '';
  return `${head}\n${kids.map((c) => renderTree(c, `${indent}  `)).join('')}${more}`;
}
