#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// ksy2wireshark <spec.ksy> [-o out.lua] [-I import-dir]... [--ksy-uri uri]
// Writes a Wireshark Lua dissector for the spec. Imports resolve relative to the spec, then to each -I directory.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { load } from 'js-yaml';
import compiler from 'kaitai-struct-compiler';
import { generateDissector, type Importer } from '../src/index.ts';
import type { Ksy } from '../src/schema.ts';

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

// The compiler asks for "name" relative to the importing spec, or "/name" from an import path. Nested relative
// imports resolve from the importing spec's directory, which the compiler doesn't pass, so search every spec
// directory seen so far.
const dirs = [dirname(input)];
const importer: Importer = {
  async importYaml(name, mode) {
    const roots = mode === 'abs' || name.startsWith('/') ? values.import : [...dirs, ...values.import];
    for (const root of roots) {
      const path = join(root, `${name.replace(/^\//, '')}.ksy`);
      if (existsSync(path)) {
        dirs.push(dirname(path));
        return read(path);
      }
    }
    throw new Error(`import ${name}: not found in ${roots.join(', ')}`);
  },
};

const { name, lua, warnings } = await generateDissector({
  ksy: read(input),
  compiler,
  importer,
  ksyUri: values['ksy-uri'] ?? input,
});
for (const w of warnings) console.error(`warning: ${w}`);
writeFileSync(values.output ?? name, lua);
