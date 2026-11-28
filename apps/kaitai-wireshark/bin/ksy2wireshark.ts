#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// ksy2wireshark <spec.ksy> [-o out.lua] [-I import-dir]... [--ksy-uri uri]
// Writes a Wireshark Lua dissector for the spec. Imports resolve relative to the spec, then to each -I directory.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { load } from 'js-yaml';
import compiler from 'kaitai-struct-compiler';
import { generateDissector, type Ksy } from '../src/index.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: 'string', short: 'o' },
    import: { type: 'string', short: 'I', multiple: true, default: [] },
    // the .ksy "Open in Kaitai IDE" opens; defaults to the input's absolute path
    'ksy-uri': { type: 'string' },
  },
});
if (positionals.length !== 1) {
  console.error('usage: ksy2wireshark <spec.ksy> [-o out.lua] [-I import-dir]... [--ksy-uri uri]');
  process.exit(2);
}

const input = resolve(positionals[0]);
const read = (path: string) => load(readFileSync(path, 'utf8')) as Ksy;

// The compiler doesn't say which spec an import is relative to, so search the directory of every spec read so far.
const dirs = [dirname(input), ...values.import];
async function importYaml(name: string): Promise<Ksy> {
  const path = dirs.map((d) => join(d, `${name}.ksy`)).find((p) => existsSync(p));
  if (!path) throw new Error(`import ${name}: not found in ${dirs.join(', ')}`);
  dirs.unshift(dirname(path));
  return read(path);
}

const ksyUri = values['ksy-uri'] ?? input;
const { name, lua, warnings } = await generateDissector({
  ksy: read(input),
  compiler,
  importer: { importYaml },
  ksyUri,
});
for (const w of warnings) console.error(`warning: ${w}`);
writeFileSync(values.output ?? name, lua);
