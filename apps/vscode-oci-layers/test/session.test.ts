import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { parseRef } from '../src/core/reference.ts';
import { RegistryClient } from '../src/core/registry.ts';
import { ImageSession } from '../src/core/session.ts';
import { type TarEntry, writeTar } from '../src/core/tar.ts';
import { type FakeRegistry, seedImage, startFakeRegistry } from './fake-registry.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const f = (path: string, text: string): TarEntry => ({
  path,
  type: 'file',
  mode: 0o644,
  uid: 0,
  gid: 0,
  mtime: 0,
  data: enc.encode(text),
});

let reg: FakeRegistry;
const client = (creds = true) =>
  new RegistryClient({
    insecure: (h) => h === '127.0.0.1',
    getCredentials: async () => (creds ? { username: 'user', password: 'pass' } : undefined),
  });

before(async () => {
  reg = await startFakeRegistry({ auth: true });
  await seedImage(reg, 'team/app', 'v1', [
    Buffer.from(writeTar([f('etc/os-release', 'base'), f('etc/motd', 'hello')])),
    Buffer.from(writeTar([f('app/main.sh', 'echo 1')])),
  ]);
});
after(() => reg.close());

test('parses Docker-style references', () => {
  assert.deepEqual(parseRef('alpine'), {
    registry: 'docker.io',
    apiHost: 'registry-1.docker.io',
    repository: 'library/alpine',
    tag: 'latest',
    digest: undefined,
  });
  assert.equal(parseRef('localhost:5000/a/b:t').apiHost, 'localhost:5000');
  assert.equal(parseRef(`ghcr.io/o/r@sha256:${'a'.repeat(64)}`).tag, undefined);
  assert.throws(() => parseRef('UPPER/case'));
});

test('opens an image through an index, commits a layer and pushes it to another repository', async () => {
  const s = await ImageSession.open(client(), `${reg.host}/team/app:v1`, { platform: 'linux/amd64' });
  assert.equal(dec.decode(s.overlay.readFile('app/main.sh')), 'echo 1');
  assert.equal(s.layers.length, 2);

  s.overlay.writeFile('app/main.sh', enc.encode('echo 2'), { create: false, overwrite: true });
  s.overlay.delete('etc/motd', false);
  const target = parseRef(`${reg.host}/team/app-edited:v2`);
  const res = await s.commit(target, 'tweak main.sh');

  // Base layers were cross-repo mounted; only the new layer and config were uploaded.
  assert.equal(reg.requests.filter((r) => r.startsWith('PUT /v2/team/app-edited/blobs/uploads/')).length, 2);
  assert.ok(reg.blobs.has(`team/app-edited@${res.layer.digest}`));
  assert.equal(s.overlay.isDirty(), false);
  assert.equal(s.layers.length, 3);

  const again = await ImageSession.open(client(), `${reg.host}/team/app-edited:v2`, { platform: 'linux/amd64' });
  assert.equal(again.resolved.manifestDigest, res.digest);
  assert.equal(dec.decode(again.overlay.readFile('app/main.sh')), 'echo 2');
  assert.throws(() => again.overlay.readFile('etc/motd'), /FileNotFound/);
  assert.equal(dec.decode(again.overlay.readFile('etc/os-release')), 'base');
  const cfg = again.resolved.config;
  assert.equal(cfg.rootfs.diff_ids.length, 3);
  assert.equal(cfg.history?.at(-1)?.comment, 'tweak main.sh');
  assert.deepEqual(cfg.config, { Cmd: ['/bin/sh'] }, 'runtime config preserved');
});

test('push without credentials fails with an actionable error', async () => {
  const s = await ImageSession.open(client(false), `${reg.host}/team/app:v1`, { platform: 'linux/amd64' });
  s.overlay.writeFile('x', enc.encode('x'), { create: true, overwrite: false });
  await assert.rejects(s.commit(parseRef(`${reg.host}/team/app:v3`), 'm'), /401.*Sign In/);
});

test('rejects unknown platforms and oversize images', async () => {
  await assert.rejects(
    ImageSession.open(client(), `${reg.host}/team/app:v1`, { platform: 'linux/s390x' }),
    /available: linux\/arm64, linux\/amd64/,
  );
  await assert.rejects(
    ImageSession.open(client(), `${reg.host}/team/app:v1`, { platform: 'linux/amd64', maxBytes: 10 }),
    /limit/,
  );
});

test('reads zstd and zstd:chunked layers (multiple and skippable frames)', async () => {
  const { zstdCompressSync } = await import('node:zlib');
  const { decompressLayer } = await import('../src/core/bytes.ts');
  const { parseTar } = await import('../src/core/tar.ts');
  const tar = Buffer.from(writeTar([f('etc/zstd', 'compressed with zstd')]));
  const half = Math.floor(tar.length / 2);
  const skippable = Buffer.alloc(8 + 4);
  skippable.writeUInt32LE(0x184d2a50, 0);
  skippable.writeUInt32LE(4, 4);
  const chunked = Buffer.concat([
    zstdCompressSync(tar.subarray(0, half)),
    zstdCompressSync(tar.subarray(half)),
    skippable,
  ]);
  for (const blob of [zstdCompressSync(tar), chunked]) {
    const entries = parseTar(await decompressLayer('application/vnd.oci.image.layer.v1.tar+zstd', blob));
    assert.equal(dec.decode(entries[0].data), 'compressed with zstd');
  }
  await assert.rejects(decompressLayer('application/vnd.oci.image.layer.v1.tar+zstd', tar), /not zstd/);
});

test('network failures (browser CORS blocks) become actionable errors', async () => {
  const c = new RegistryClient({
    fetch: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  await assert.rejects(
    c.getManifest(parseRef('ghcr.io/o/r:t')),
    (e: { network?: boolean; message: string }) =>
      e.network === true && /cannot reach ghcr\.io.*corsProxy/.test(e.message),
  );
});
