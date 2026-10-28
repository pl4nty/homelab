// In-process OCI registry for tests: Bearer token auth, blob mounts, monolithic uploads.
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';

export interface FakeRegistry {
  server: Server;
  host: string; // "127.0.0.1:port"
  manifests: Map<string, { body: Buffer; type: string }>; // "repo@ref"
  blobs: Map<string, Buffer>; // "repo@digest"
  requests: string[];
  close(): Promise<void>;
}

const digestOf = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export async function startFakeRegistry(opts: { auth?: boolean } = {}): Promise<FakeRegistry> {
  const manifests = new Map<string, { body: Buffer; type: string }>();
  const blobs = new Map<string, Buffer>();
  const uploads = new Map<string, string>();
  const requests: string[] = [];
  let host = '';

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://${host}`);
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    const data = await body(req);

    if (url.pathname === '/token') {
      // Token = base64 of the requested scopes; anonymous users get pull only.
      const authed = req.headers.authorization === `Basic ${Buffer.from('user:pass').toString('base64')}`;
      const scopes = url.searchParams.getAll('scope').map((s) => (authed ? s : s.replace(/push/, '')));
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ token: Buffer.from(JSON.stringify(scopes)).toString('base64') }));
    }

    const m = /^\/v2\/(.+?)\/(manifests|blobs)\/(.+)$/.exec(url.pathname);
    if (!m) {
      res.statusCode = 404;
      return res.end();
    }
    const [, repo, kind, ref] = m;
    const write = req.method !== 'GET' && req.method !== 'HEAD';

    if (opts.auth) {
      const tok = req.headers.authorization?.replace(/^Bearer /, '');
      const scopes: string[] = tok ? JSON.parse(Buffer.from(tok, 'base64').toString()) : [];
      const ok = scopes.some((s) => s.startsWith(`repository:${repo}:`) && (!write || s.includes('push')));
      if (!ok) {
        res.statusCode = 401;
        res.setHeader(
          'www-authenticate',
          `Bearer realm="http://${host}/token",service="fake",scope="repository:${repo}:pull"`,
        );
        return res.end();
      }
    }

    if (kind === 'manifests') {
      if (req.method === 'PUT') {
        const entry = { body: data, type: req.headers['content-type']! };
        manifests.set(`${repo}@${ref}`, entry);
        manifests.set(`${repo}@${digestOf(data)}`, entry);
        res.statusCode = 201;
        res.setHeader('docker-content-digest', digestOf(data));
        return res.end();
      }
      const mf = manifests.get(`${repo}@${ref}`);
      if (!mf) {
        res.statusCode = 404;
        return res.end();
      }
      res.setHeader('content-type', mf.type);
      return res.end(req.method === 'HEAD' ? undefined : mf.body);
    }

    if (ref.startsWith('uploads/')) {
      const id = ref.slice('uploads/'.length);
      if (req.method === 'POST' && id === '') {
        const mount = url.searchParams.get('mount');
        const from = url.searchParams.get('from');
        if (mount && from && blobs.has(`${from}@${mount}`)) {
          blobs.set(`${repo}@${mount}`, blobs.get(`${from}@${mount}`)!);
          res.statusCode = 201;
          return res.end();
        }
        const uuid = randomUUID();
        uploads.set(uuid, repo);
        res.statusCode = 202;
        res.setHeader('location', `/v2/${repo}/blobs/uploads/${uuid}?state=x`);
        return res.end();
      }
      if (req.method === 'PUT' && uploads.has(id)) {
        const digest = url.searchParams.get('digest')!;
        if (digestOf(data) !== digest) {
          res.statusCode = 400;
          return res.end('DIGEST_INVALID');
        }
        blobs.set(`${repo}@${digest}`, data);
        uploads.delete(id);
        res.statusCode = 201;
        return res.end();
      }
      if (req.method === 'DELETE') {
        uploads.delete(id);
        res.statusCode = 204;
        return res.end();
      }
      res.statusCode = 404;
      return res.end();
    }

    const blob = blobs.get(`${repo}@${ref}`);
    if (!blob) {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader('content-length', blob.length);
    return res.end(req.method === 'HEAD' ? undefined : blob);
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  host = `127.0.0.1:${addr.port}`;
  return {
    server,
    host,
    manifests,
    blobs,
    requests,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** Seed an image (single platform, wrapped in an index) from layer tarballs. */
export async function seedImage(reg: FakeRegistry, repo: string, tag: string, layers: Buffer[]): Promise<void> {
  const { gzipSync } = await import('node:zlib');
  const descs = layers.map((tar) => {
    const gz = gzipSync(tar);
    reg.blobs.set(`${repo}@${digestOf(gz)}`, gz);
    return {
      mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
      digest: digestOf(gz),
      size: gz.length,
      diffId: digestOf(tar),
    };
  });
  const config = Buffer.from(
    JSON.stringify({
      architecture: 'amd64',
      os: 'linux',
      config: { Cmd: ['/bin/sh'] },
      rootfs: { type: 'layers', diff_ids: descs.map((d) => d.diffId) },
      history: descs.map((_, i) => ({ created_by: `layer ${i}` })),
    }),
  );
  reg.blobs.set(`${repo}@${digestOf(config)}`, config);
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: digestOf(config), size: config.length },
      layers: descs.map(({ diffId: _, ...d }) => d),
    }),
  );
  const mtype = 'application/vnd.oci.image.manifest.v1+json';
  reg.manifests.set(`${repo}@${digestOf(manifest)}`, { body: manifest, type: mtype });
  const index = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [
        {
          mediaType: mtype,
          digest: `sha256:${'0'.repeat(64)}`,
          size: 1,
          platform: { os: 'linux', architecture: 'arm64' },
        },
        {
          mediaType: mtype,
          digest: digestOf(manifest),
          size: manifest.length,
          platform: { os: 'linux', architecture: 'amd64' },
        },
      ],
    }),
  );
  reg.manifests.set(`${repo}@${tag}`, { body: index, type: 'application/vnd.oci.image.index.v1+json' });
}
