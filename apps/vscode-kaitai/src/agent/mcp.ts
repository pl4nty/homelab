// MCP server (stdio) exposing the CLI operations as tools. Outputs are capped so a large file cannot flood the
// client's context; every tool says how to drill down instead.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { parseUint } from '../util/parse.ts';
import { Kaitai, LANGUAGES } from './ops.ts';
import type { SourceOptions } from './source.ts';
import { VERSION } from './version.ts';

const INSTRUCTIONS = `Parses binary files with Kaitai Struct (.ksy) specs; no Java or ksc needed.
Workflow: kaitai_suggest finds a gallery spec for a file (or write your own .ksy and check it with kaitai_validate),
kaitai_parse shows the parsed tree a few levels at a time (drill down with "path"), kaitai_at explains the bytes at an
offset. Specs are .ksy file paths or "gallery:<category>/<name>" from the format gallery. Use absolute file paths.
Results are JSON; "range" is [start, end) in file offsets and "truncated" says why children are missing.`;

const spec = {
  spec: z
    .string()
    .optional()
    .describe('Path to a .ksy file, or gallery:<path> for the format gallery (e.g. gallery:image/png)'),
  source: z.string().optional().describe('Inline .ksy YAML, instead of spec'),
};
const target = {
  ...spec,
  file: z.string().describe('Path of the binary file to parse'),
  type: z.string().optional().describe('Parse as this user type (a::b) instead of the root type'),
  params: z
    .array(z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe('Values for the root type params, in order. Strings: 0x10, "text", [1, 2] for bytes'),
};
const offset = z.union([z.number().int().nonnegative(), z.string()]);

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };

async function run(task: () => Promise<unknown>): Promise<Result> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await task()) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: (e as Error).message ?? String(e) }], isError: true };
  }
}

export function createServer(opts: SourceOptions = {}): McpServer {
  const k = new Kaitai(opts);
  const server = new McpServer({ name: 'kaitai', version: VERSION }, { instructions: INSTRUCTIONS });
  const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

  server.registerTool(
    'kaitai_parse',
    {
      title: 'Parse a binary file',
      description:
        'Parses a file with a .ksy spec and returns the tree from the root, or from "path", a few levels deep. ' +
        'Array items past max_items and structs past depth are left out and marked "truncated"; request them with ' +
        '"path" (e.g. "chunks/3" or "chunks[3].body") and "from". Instances (lazy fields) are included.',
      inputSchema: {
        ...target,
        path: z.string().optional().describe('Node to start from: field names and array indices, / or . separated'),
        from: z.number().int().nonnegative().optional().describe('First item to show when path is an array'),
        depth: z.number().int().min(0).max(32).optional().describe('Levels below the start node (default 3)'),
        max_items: z.number().int().min(1).max(1000).optional().describe('Items per array (default 20)'),
        max_nodes: z.number().int().min(1).max(5000).optional().describe('Total nodes returned (default 400)'),
        include_instances: z.boolean().optional().describe('Include instances (default true)'),
      },
      annotations: readOnly,
    },
    (a) =>
      run(() =>
        k.parse({
          ...a,
          typeName: a.type,
          maxItems: a.max_items,
          maxNodes: a.max_nodes,
          noInstances: a.include_instances === false,
        }),
      ),
  );

  server.registerTool(
    'kaitai_at',
    {
      title: 'Explain bytes at an offset',
      description:
        'The deepest parsed field covering a file offset: its path, the structs containing it (with ranges) and ' +
        'its value. Bytes inside processed (e.g. compressed) streams have no file offset and are not found.',
      inputSchema: { ...target, offset: offset.describe('File offset, a number or a "0x" hex string') },
      annotations: readOnly,
    },
    (a) =>
      run(() => {
        const at = typeof a.offset === 'number' ? a.offset : parseUint(a.offset.trim());
        if (Number.isNaN(at)) throw new Error(`Bad offset ${a.offset}`);
        return k.at({ ...a, offset: at, typeName: a.type });
      }),
  );

  server.registerTool(
    'kaitai_validate',
    {
      title: 'Check a .ksy spec',
      description:
        'Checks YAML syntax and compiles the spec (with its imports). Errors have 1-based line/column, the YAML ' +
        'path, and "did you mean" suggestions for unknown types and enums. The compiler stops at the first error.',
      inputSchema: spec,
      annotations: readOnly,
    },
    (a) => run(() => k.validate(a)),
  );

  server.registerTool(
    'kaitai_suggest',
    {
      title: 'Find a spec for a file',
      description:
        "Gallery specs that list the file's extension. With try_parse (default true), parses the file with each " +
        'and ranks them: ok means no parse error, coverage is the share of the file the top-level fields cover.',
      inputSchema: {
        file: z.string().describe('Path of the binary file'),
        try_parse: z.boolean().optional().describe('Parse the file with each candidate (default true)'),
      },
      annotations: readOnly,
    },
    (a) => run(() => k.suggest({ file: a.file, tryParse: a.try_parse ?? true })),
  );

  server.registerTool(
    'kaitai_compile',
    {
      title: 'Generate parser code',
      description: `Compiles a spec to parser source code. Languages: ${LANGUAGES.join(', ')}.`,
      inputSchema: {
        ...spec,
        language: z.string().describe('Target language'),
        max_chars: z.number().int().min(1000).optional().describe('Total characters returned (default 50000)'),
      },
      annotations: readOnly,
    },
    (a) => run(() => k.compile({ ...a, maxChars: a.max_chars ?? 50_000 })),
  );

  return server;
}

export async function serve(opts: SourceOptions = {}) {
  const server = createServer(opts);
  await server.connect(new StdioServerTransport());
  // Resolve when the client closes stdin, so the CLI exits cleanly.
  await new Promise<void>((done) => {
    server.server.onclose = done;
  });
}
