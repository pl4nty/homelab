import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as age from 'age-encryption';
import { parse } from 'yaml';
import { decrypt, encrypt, GoTime, goFloat, newContext } from '../src/sops.js';

const identity = await age.generateIdentity();
const recipient = await age.identityToRecipient(identity);
const dir = mkdtempSync(join(tmpdir(), 'sops-'));
const env = { ...process.env, SOPS_AGE_KEY: identity, SOPS_AGE_RECIPIENTS: recipient };

function sops(args, text, name = 'f.sops.yaml') {
  const f = join(dir, name);
  writeFileSync(f, text);
  return execFileSync('sops', [...args, '--input-type', 'yaml', '--output-type', 'yaml', f], { env, encoding: 'utf8' });
}
const sopsEncrypt = (text, regex = '^(data|stringData)$') => sops(['encrypt', '--encrypted-regex', regex], text);
const sopsDecrypt = (text) => sops(['decrypt'], text);
const js = (text) =>
  parse(text, {
    customTags: [
      {
        tag: 'tag:yaml.org,2002:timestamp',
        test: /^\d{4}-\d\d?-\d\d?(?:[Tt ].*)?$/,
        resolve: (s) => new GoTime(s).text,
      },
    ],
  });

const fixtures = {
  secret: `apiVersion: v1
kind: Secret
metadata:
  name: x
type: Opaque
stringData:
  TOKEN: abc
  EMPTY: ""
  JSON: '{"a": 1}'
  NUM_STR: "123"
  MULTI: |
    line1
    line2
`,
  types: `# top
data: # on data
    # before x
    x: y # inline x
    n: 12
    neg: -3
    f: 1.50
    big: 1e21
    small: 0.000001
    b: true
    t: 2001-12-14
    ts: 2001-12-14T21:59:43.10+10:00
    nul: null
    nested:
        deep:
            - a
            - k: v
    list:
        # before item
        - q # inl item
        - 3
    # foot of data
plain: 2001-12-14
count: 3
# doc end
`,
  allEncrypted: `# head
a: 1
b:
  - x
  - {y: z}
# tail
`,
};

for (const [name, plain] of Object.entries(fixtures)) {
  test(`${name}: decrypt matches sops`, async () => {
    const encrypted = name === 'allEncrypted' ? sops(['encrypt'], plain) : sopsEncrypt(plain);
    const { plain: ours } = await decrypt(encrypted, [identity]);
    assert.deepEqual(js(ours), js(sopsDecrypt(encrypted)));
  });

  test(`${name}: edited file decrypts with sops`, async () => {
    const encrypted = name === 'allEncrypted' ? sops(['encrypt'], plain) : sopsEncrypt(plain);
    const { plain: ours, ctx } = await decrypt(encrypted, [identity]);
    const edited = ours.replace(/^(\s+)(\S+): /m, '$1added: new value # with comment\n$1$2: ');
    const out = await encrypt(edited, ctx);
    assert.deepEqual(js(sopsDecrypt(out)), js(edited));
    const again = await decrypt(out, [identity]);
    assert.deepEqual(js(again.plain), js(edited));
  });
}

test('unchanged values keep their ciphertext', async () => {
  const encrypted = sopsEncrypt(fixtures.secret);
  const { plain, ctx } = await decrypt(encrypted, [identity]);
  const out = await encrypt(plain.replace('TOKEN: abc', 'TOKEN: def'), ctx, new Date(Date.now() + 5000));
  const changed = out.split('\n').filter((l, i) => l !== encrypted.split('\n')[i]);
  assert.deepEqual(
    changed.map((l) => l.trim().split(':')[0]),
    ['TOKEN', 'lastmodified', 'mac'],
  );
});

test('tampered file fails MAC check', async () => {
  const encrypted = sopsEncrypt(fixtures.secret).replace('type: Opaque', 'type: Other');
  await assert.rejects(decrypt(encrypted, [identity]), /MAC mismatch/);
});

test('wrong identity is rejected', async () => {
  await assert.rejects(decrypt(sopsEncrypt(fixtures.secret), [await age.generateIdentity()]), /no identity matched/);
});

test('new file from creation rule decrypts with sops', async () => {
  const config = `creation_rules:
- path_regex: private-[0-9]+\\.sops\\.yaml$
  encrypted_regex: ^(image|env)$
- path_regex: .+\\.sops\\.yaml$
  encrypted_regex: ^(data|stringData)$
stores:
  yaml:
    indent: 2
`;
  const ctx = await newContext('kubernetes/oke/foo.sops.yaml', config, [recipient]);
  const out = await encrypt(fixtures.secret, ctx);
  assert.match(out, /TOKEN: ENC\[/);
  assert.match(out, /^ {2}name: x$/m);
  assert.deepEqual(js(sopsDecrypt(out)), js(fixtures.secret));
});

test('goFloat matches strconv', () => {
  assert.equal(goFloat(1e21), '1000000000000000000000');
  assert.equal(goFloat(1e-7), '0.0000001');
  assert.equal(goFloat(1.5), '1.5');
  assert.equal(goFloat(-2.5e-8), '-0.000000025');
});
