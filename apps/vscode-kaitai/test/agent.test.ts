// CLI and MCP server (src/agent). Offline: specs come from test/fixtures and temp folders.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { main, renderTree } from '../src/agent/cli.ts';
import { createServer } from '../src/agent/mcp.ts';
import { Kaitai } from '../src/agent/ops.ts';

const fixtures = join(import.meta.dirname, 'fixtures');
const png = join(fixtures, 'image', 'png.ksy');
const sample = join(fixtures, 'sample.png');
const k = new Kaitai({ network: false });

async function tmp(files: Record<string, string | Uint8Array>) {
  const dir = await mkdtemp(join(tmpdir(), 'kaitai-agent-'));
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return dir;
}

test('parse returns a capped tree with ranges, enums and summaries', async () => {
  const r = await k.parse({ spec: png, file: sample, depth: 2, maxItems: 2 });
  assert.equal(r.id, 'png');
  assert.equal(r.error, undefined);
  const tree = r.tree!;
  assert.deepEqual(tree.range, [0, r.fileSize]);
  const ihdr = tree.fields!.find((f) => f.name === 'ihdr')!;
  const colour = ihdr.fields!.find((f) => f.name === 'color_type')!;
  assert.equal(colour.kind, 'enum');
  assert.equal(colour.enum, 'truecolor');
  assert.equal(colour.value, 2);
  const magic = tree.fields!.find((f) => f.name === 'magic')!;
  assert.equal(magic.value, '89 50 4e 47 0d 0a 1a 0a');
  assert.deepEqual(magic.range, [0, 8]);
  const chunks = tree.fields!.find((f) => f.name === 'chunks')!;
  assert.equal(chunks.count, 3);
  assert.equal(chunks.items!.length, 2);
  assert.equal(chunks.truncated, 'items');
  // depth 2 ends at the chunk structs.
  assert.equal(chunks.items![0].truncated, 'depth');
  assert.equal(chunks.items![0].fields, undefined);
});

test('parse drills down by path and pages arrays with from', async () => {
  const one = await k.parse({ spec: png, file: sample, path: 'chunks[1].len' });
  assert.equal(one.tree!.name, 'len');
  assert.equal(one.path, 'png/chunks/[1]/len');
  assert.equal(typeof one.tree!.value, 'number');
  const same = await k.parse({ spec: png, file: sample, path: 'png/chunks/1/len' });
  assert.deepEqual(same.tree, one.tree);
  const page = await k.parse({ spec: png, file: sample, path: 'chunks', from: 2, depth: 1 });
  assert.equal(page.tree!.from, 2);
  assert.deepEqual(
    page.tree!.items!.map((i) => i.name),
    ['[2]'],
  );
  await assert.rejects(k.parse({ spec: png, file: sample, path: 'chunks/9' }), /No "9" in png\/chunks.*indices 0\.\.2/);
  await assert.rejects(k.parse({ spec: png, file: sample, path: 'nope' }), /No "nope" in png.*fields: magic/);
  await assert.rejects(k.parse({ spec: png, file: join(fixtures, 'nope.png') }), /Cannot read .*nope\.png: ENOENT/);
});

test('values that JSON cannot hold are converted, and summaries are capped', async () => {
  const dir = await tmp({
    'v.ksy': `meta: { id: v, endian: le }
-webide-representation: '{text}'
seq:
  - { id: nan, type: f4 }
  - { id: text, type: str, size: 8, encoding: ASCII }
`,
    'v.bin': new Uint8Array([0, 0, 192, 127, ...Buffer.from('abcdefgh')]),
  });
  const r = await k.parse({ spec: join(dir, 'v.ksy'), file: join(dir, 'v.bin'), maxString: 4 });
  assert.equal(r.error, undefined);
  assert.equal(r.tree!.summary, 'abcd…');
  const [nan, text] = r.tree!.fields!;
  assert.equal(nan.value, 'NaN');
  assert.deepEqual([text.value, text.size], ['abcd…', 8]);
  JSON.stringify(r);
});

test('maxNodes cuts the output and marks it', async () => {
  const r = await k.parse({ spec: png, file: sample, depth: 10, maxNodes: 5 });
  const json = JSON.stringify(r.tree);
  assert.match(json, /"truncated":"nodes"/);
});

test('resolvePath walks into array buckets', async () => {
  const dir = await tmp({
    'many.ksy': 'meta: { id: many }\nseq:\n  - { id: xs, type: u1, repeat: eos }\n',
    'many.bin': new Uint8Array(250).map((_, i) => i),
  });
  const r = await k.parse({ spec: join(dir, 'many.ksy'), file: join(dir, 'many.bin'), path: 'xs/[234]' });
  assert.equal(r.tree!.value, 234);
  assert.deepEqual(r.tree!.range, [234, 235]);
  const page = await k.parse({ spec: join(dir, 'many.ksy'), file: join(dir, 'many.bin'), path: 'xs', from: 198 });
  assert.deepEqual(
    page.tree!.items!.map((i) => i.value),
    Array.from({ length: 20 }, (_, i) => 198 + i),
  );
});

test('at leaves array buckets out of the path', async () => {
  const dir = await tmp({
    'gap.ksy': `meta: { id: gap }
seq:
  - { id: xs, type: x, size: 2, repeat: eos }
types:
  x:
    seq:
      - { id: v, type: u1 }
`,
    'gap.bin': new Uint8Array(400),
  });
  const r = await k.at({ spec: join(dir, 'gap.ksy'), file: join(dir, 'gap.bin'), offset: 301 });
  assert.equal(r.path, 'gap/xs/[150]');
  assert.deepEqual(
    r.chain!.map((c) => c.name),
    ['gap', 'xs', '[150]'],
  );
});

test('at finds the deepest field and its containers', async () => {
  const r = await k.at({ spec: png, file: sample, offset: 0x19 });
  assert.equal(r.path, 'png/ihdr/color_type');
  assert.deepEqual(
    r.chain!.map((c) => c.name),
    ['png', 'ihdr', 'color_type'],
  );
  assert.equal(r.node!.enum, 'truecolor');
  await assert.rejects(k.at({ spec: png, file: sample, offset: 1e9 }), /outside the file/);
});

test('validate reports YAML and compiler errors with positions and suggestions', async () => {
  const bad = await k.validate({
    source:
      'meta:\n  id: bad\nseq:\n  - id: a\n    type: chunkk\ntypes:\n  chunk:\n    seq:\n      - { id: x, type: u1 }\n',
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 1);
  const e = bad.errors[0];
  assert.equal(e.source, 'kaitai');
  assert.equal(e.path, '/seq/0/type');
  assert.equal(e.line, 5);
  assert.equal(e.column, 11);
  assert.deepEqual(e.suggestions, ['chunk']);

  const yaml = await k.validate({ source: 'meta:\n  id: x\n seq: [\n' });
  assert.equal(yaml.ok, false);
  assert.ok(yaml.errors.every((x) => x.source === 'yaml'));

  const good = await k.validate({ spec: png });
  assert.deepEqual({ ok: good.ok, errors: good.errors }, { ok: true, errors: [] });
});

test('imports resolve relatively, through ancestors and import paths', async () => {
  const lib = await tmp({ 'u.ksy': 'meta: { id: u }\nseq:\n  - { id: v, type: u1 }\n' });
  const dir = await tmp({
    'root.ksy': 'meta: { id: root, imports: [/u] }\nseq:\n  - { id: x, type: u }\n',
    'd.bin': new Uint8Array([7]),
  });
  await assert.rejects(k.parse({ spec: join(dir, 'root.ksy'), file: join(dir, 'd.bin') }), /Cannot find imported spec/);
  const withPath = new Kaitai({ network: false, importPaths: [lib] });
  const r = await withPath.parse({ spec: join(dir, 'root.ksy'), file: join(dir, 'd.bin') });
  assert.equal(r.tree!.fields![0].fields![0].value, 7);
});

test('an edited import is recompiled', async () => {
  const dir = await tmp({
    'root.ksy': 'meta: { id: root, imports: [u] }\nseq:\n  - { id: x, type: u }\n',
    'u.ksy': 'meta: { id: u }\nseq:\n  - { id: v, type: u1 }\n',
    'd.bin': new Uint8Array([7, 8]),
  });
  const input = { spec: join(dir, 'root.ksy'), file: join(dir, 'd.bin'), path: 'x/v' };
  assert.equal((await k.parse(input)).tree!.value, 7);
  await writeFile(join(dir, 'u.ksy'), 'meta: { id: u }\nseq:\n  - { id: v, type: u2be }\n');
  assert.equal((await k.parse(input)).tree!.value, 0x0708);
});

test('suggest uses the bundled extension map', async () => {
  const r = await k.suggest({ file: sample });
  assert.deepEqual(
    r.candidates.map((c) => c.spec),
    ['gallery:image/png.ksy'],
  );
  const none = await k.suggest({ file: 'x.unknownext' });
  assert.equal(none.candidates.length, 0);
  assert.ok(none.note);
});

test('gallery specs need the network', async () => {
  await assert.rejects(
    k.parse({ spec: 'gallery:image/png', file: sample }),
    /No image\/png\.ksy.*network is turned off/,
  );
  await assert.rejects(k.parse({ spec: 'image/png', file: sample }), /use "gallery:image\/png"/);
});

test('compile generates code and caps it', async () => {
  const r = await k.compile({ spec: png, language: 'python', maxChars: 1000 });
  const files = Object.keys(r.files);
  assert.ok(files.includes('png.py'));
  assert.ok(Object.values(r.files).join('').length < 1100);
  assert.equal(r.truncated, true);
  await assert.rejects(k.compile({ spec: png, language: 'cobol' }), /Unknown language/);
});

function capture() {
  let text = '';
  return {
    stream: { write: (s: string) => (text += s) },
    get text() {
      return text;
    },
  };
}

test('CLI prints text or JSON and sets exit codes', async () => {
  const out = capture();
  const err = capture();
  assert.equal(await main(['parse', png, sample, '--depth', '1', '--offline'], out.stream, err.stream), 0);
  assert.match(out.text, /^png: Png \[0x0\.\.0x1fc\)\n {2}magic \[0x0\.\.0x8\) = "89 50/);

  const json = capture();
  assert.equal(await main(['at', png, sample, '0x19', '--json', '--offline'], json.stream, err.stream), 0);
  assert.equal(JSON.parse(json.text).path, 'png/ihdr/color_type');

  const dir = await tmp({ 'bad.ksy': 'meta: { id: bad }\nseq:\n  - { id: a, type: nope }\n' });
  const v = capture();
  assert.equal(await main(['validate', join(dir, 'bad.ksy')], v.stream, err.stream), 1);
  assert.match(v.text, /bad\.ksy:3:20: error: unable to find type 'nope'/);

  const usage = capture();
  assert.equal(await main(['frobnicate'], out.stream, usage.stream), 2);
  assert.match(usage.text, /Unknown command frobnicate/);
});

test('KAITAI_OFFLINE applies without --offline', async (t) => {
  process.env.KAITAI_OFFLINE = '1';
  t.after(() => delete process.env.KAITAI_OFFLINE);
  const err = capture();
  assert.equal(await main(['parse', 'gallery:image/png', sample], capture().stream, err.stream), 1);
  assert.match(err.text, /network is turned off/);
});

test('renderTree shows truncation hints', () => {
  const text = renderTree({
    name: 'xs',
    kind: 'array',
    count: 10,
    items: [{ name: '[0]', kind: 'number', value: 1, range: [0, 1] }],
    truncated: 'items',
  });
  assert.equal(text, 'xs [10]\n  [0] [0x0..0x1) = 1\n  … items 0..0 of 10 shown (--from, --max-items)\n');
});

test('MCP server lists the tools and answers calls', async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createServer({ network: false });
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'kaitai_at',
    'kaitai_compile',
    'kaitai_parse',
    'kaitai_suggest',
    'kaitai_validate',
  ]);
  const at = await client.callTool({ name: 'kaitai_at', arguments: { spec: png, file: sample, offset: '0x19' } });
  const content = at.content as { text: string }[];
  assert.equal(at.isError, undefined);
  assert.equal(JSON.parse(content[0].text).path, 'png/ihdr/color_type');
  const bad = await client.callTool({ name: 'kaitai_parse', arguments: { file: sample } });
  assert.equal(bad.isError, true);
  assert.match((bad.content as { text: string }[])[0].text, /Give either a spec/);
  await client.close();
});
