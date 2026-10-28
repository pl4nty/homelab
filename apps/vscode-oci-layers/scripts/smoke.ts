// Smoke test against a real registry: pull, edit, commit to an in-process registry, re-pull.
// Usage: node --experimental-strip-types scripts/smoke.ts [image]
import { parseRef } from '../src/core/reference.ts';
import { RegistryClient } from '../src/core/registry.ts';
import { ImageSession } from '../src/core/session.ts';
import { startFakeRegistry } from '../test/fake-registry.ts';

const image = process.argv[2] ?? 'alpine:3.20';
const reg = await startFakeRegistry();
const targetHost = process.env.TARGET ?? reg.host;
const client = new RegistryClient({ insecure: (h) => h.startsWith('127.0.0.1') || h.startsWith('localhost') });
const t0 = Date.now();
const s = await ImageSession.open(client, image, { platform: 'linux/amd64', progress: console.log });
console.log(`opened in ${Date.now() - t0} ms; ${s.overlay.base.nodes.size} paths; pinned ${s.pinned}`);
const dec = new TextDecoder();
console.log(dec.decode(s.overlay.readFile('etc/os-release')).split('\n')[0]);
console.log('bin/sh ->', s.overlay.resolve('bin/sh'));
s.overlay.writeFile('etc/motd', new TextEncoder().encode('edited in vscode\n'), { create: true, overwrite: true });
s.overlay.delete('etc/issue', false);
console.log(s.overlay.changes());
const res = await s.commit(parseRef(`${targetHost}/copy/${image.split(':')[0].split('/').pop()}:edited`), 'smoke test', console.log);
console.log('pushed', res.digest, 'layer', res.layer.size, 'bytes');
const again = await ImageSession.open(client, `${targetHost}/copy/${image.split(':')[0].split('/').pop()}:edited`, { platform: 'linux/amd64' });
console.log('re-pulled motd:', JSON.stringify(dec.decode(again.overlay.readFile('etc/motd'))), 'issue exists:', !!again.overlay.lookup('etc/issue'));
await reg.close();
