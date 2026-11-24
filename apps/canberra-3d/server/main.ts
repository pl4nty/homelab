import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { TILE_Z, tileInExtent } from '../shared/geo.ts';
import { Baker } from './bake.ts';
import { DiskCache } from './cache.ts';
import { Dem } from './dem.ts';
import { farTerrain } from './far.ts';
import { Live } from './live.ts';
import { latestRelease, Overture } from './overture.ts';

const gz = promisify(gzip);
const PORT = Number(process.env.PORT ?? 8080);
const DATA_DIR = process.env.DATA_DIR ?? '/data';
const WEB_DIR = process.env.WEB_DIR ?? '/web';

const disk = new DiskCache(DATA_DIR);
const dem = new Dem(disk);
const live = new Live(disk);

let baker: Baker | null = null;
let checking: Promise<Baker> | null = null;
let checkedAt = 0;
/** The Overture release is looked up daily; a new one starts a fresh set of tiles. */
function getBaker(): Promise<Baker> {
  if (baker && Date.now() - checkedAt < 86400e3) return Promise.resolve(baker);
  checking ??= (async () => {
    try {
      const release = process.env.OVERTURE_RELEASE ?? (await latestRelease());
      if (baker?.release !== release) {
        console.log(`using Overture release ${release}`);
        baker = new Baker(disk, new Overture(release), dem);
      }
      checkedAt = Date.now();
    } catch (e) {
      // Keep serving the last good release while the listing is unreachable, and look again in ten minutes.
      if (!baker) throw e;
      checkedAt = Date.now() - 86400e3 + 600e3;
    } finally {
      checking = null;
    }
    return baker!;
  })();
  return baker ? Promise.resolve(baker) : checking;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res: ServerResponse, status: number, body: Buffer | string, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-length': Buffer.byteLength(body), 'x-content-type-options': 'nosniff', ...headers });
  res.end(body);
}

async function sendJson(res: ServerResponse, value: unknown, cache: string) {
  send(res, 200, await gz(JSON.stringify(value)), {
    'content-type': 'application/json',
    'content-encoding': 'gzip',
    'cache-control': cache,
  });
}

async function serveStatic(res: ServerResponse, urlPath: string) {
  const rel = path.normalize(decodeURIComponent(urlPath)).replace(/^([/\\]|\.\.)+/, '');
  let file = path.join(WEB_DIR, rel || 'index.html');
  if (!file.startsWith(path.resolve(WEB_DIR))) return send(res, 403, 'forbidden');
  let info = await stat(file).catch(() => null);
  if (!info?.isFile()) {
    file = path.join(WEB_DIR, 'index.html');
    info = await stat(file).catch(() => null);
    if (!info) return send(res, 404, 'not found');
  }
  const hashed = file.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
    const tile = url.pathname.match(/^\/api\/tile\/(\d+)\/(\d+)\/(\d+)$/);
    if (tile) {
      const [z, x, y] = tile.slice(1).map(Number);
      if (z !== TILE_Z || !tileInExtent(x, y)) return send(res, 404, 'outside the model');
      const b = await getBaker();
      const { body, missing } = await b.tile(x, y);
      return send(res, 200, body, {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        // A tile missing a source is retried soon; a whole one keeps until the next release.
        'cache-control': missing.length ? 'no-store' : 'public, max-age=86400',
        ...(missing.length ? { 'x-missing': missing.join(', ') } : {}),
      });
    }
    if (url.pathname === '/api/far') return sendJson(res, await farTerrain(dem, disk), 'public, max-age=604800');
    if (url.pathname === '/api/live') {
      const at = Number(url.searchParams.get('at')) || undefined;
      return sendJson(res, await live.current(at), 'no-store');
    }
    if (url.pathname === '/api/transit') return sendJson(res, await live.transit(), 'public, max-age=3600');
    if (url.pathname === '/healthz') return send(res, 200, 'ok');
    if (url.pathname.startsWith('/api/')) return send(res, 404, 'not found');
    await serveStatic(res, url.pathname);
  } catch (e) {
    console.error(`${req.url}: ${(e as Error).stack ?? e}`);
    if (!res.headersSent) send(res, 502, 'upstream data unavailable');
    else res.end();
  }
});

server.listen(PORT, () => console.log(`canberra-3d listening on :${PORT}, cache in ${DATA_DIR}`));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => server.close(() => process.exit(0)));
