import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { checkConfig } from '../src/hardening.js';
import { Kconfig, parseNum } from '../src/kconfig.js';

const data = process.env.KCONFIG_DATA ?? 'public/data';
const ref = process.env.KCONFIG_REF;

test('parses numbers like Python int()', () => {
  assert.equal(parseNum('0x1f', 16), 31n);
  assert.equal(parseNum('1f', 16), 31n);
  assert.equal(parseNum(' 1_000 ', 10), 1000n);
  assert.equal(parseNum('-0x10', 0), -16n);
  assert.equal(parseNum('010', 0), null);
  assert.equal(parseNum('0x10', 10), null);
  assert.equal(parseNum('foo', 0), null);
});

if (ref) {
  const { trees, hardening } = JSON.parse(readFileSync(join(data, 'trees.json'), 'utf8'));
  for (const tree of trees) {
    for (const arch of tree.arches) {
      const db = JSON.parse(gunzipSync(readFileSync(join(data, tree.id, `${arch}.json.gz`))));
      const kconf = new Kconfig(db);
      const dir = join(ref, tree.id, arch);
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.config'))) {
        const name = file.slice(0, -'.config'.length);
        test(`${tree.id} ${arch} ${name} matches kconfiglib`, () => {
          kconf.load(name === 'alldefconfig' ? '' : readFileSync(join(data, tree.id, arch, 'configs', name), 'utf8'));
          assert.equal(kconf.write(), readFileSync(join(dir, file), 'utf8'));
          assert.equal(kconf.minConfig(), readFileSync(join(dir, `${name}.min`), 'utf8'));
          if (existsSync(join(dir, `${name}.khc.json`))) {
            const { results } = checkConfig(hardening, kconf.write());
            assert.deepEqual(
              results.map((r) => [r.name, r.result]),
              JSON.parse(readFileSync(join(dir, `${name}.khc.json`), 'utf8')),
            );
          }
        });
      }
    }
  }
}
