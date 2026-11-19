import { catalogFiles, searchCatalog } from './catalog.ts';
import { explore, FAMILIES, geo, PARTITIONS, SCOPES } from './do.ts';
import { storeFileUrl, storeInstallers, storeProduct } from './store.ts';
import { whois } from './whois.ts';

const routes: Record<string, (q: URLSearchParams) => Promise<unknown>> = {
  '/api/geo': () => geo(),
  '/api/store': async (q) => {
    const id = q.get('id')!.trim();
    const listing = await storeInstallers(id);
    if (listing.installers.length) return { kind: 'installers', ...listing };
    const product = await storeProduct(id);
    // newest package versions first
    const version = (m: string) => (m.split('_')[1] ?? '').split('.').map(Number);
    product.files.sort((a, b) => {
      const [x, y] = [version(a.moniker), version(b.moniker)];
      for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return (y[i] ?? 0) - (x[i] ?? 0);
      return a.moniker.localeCompare(b.moniker);
    });
    return { kind: 'fe3', ...product };
  },
  '/api/store/url': (q) => storeFileUrl(q.get('updateId')!, q.get('revision')!),
  '/api/catalog': (q) => searchCatalog(q.get('q')!),
  '/api/catalog/files': (q) => catalogFiles(q.get('id')!),
  '/api/whois': (q) => whois(q.get('ip')!),
  '/api/explore': (q) =>
    explore({
      url: q.get('url') || undefined,
      contentId: q.get('contentId') || undefined,
      families: FAMILIES.filter((f) => (q.get('families') ?? FAMILIES.join(',')).split(',').includes(String(f))),
      joins: Math.min(Math.max(Number(q.get('joins')) || 1, 1), 10),
      partition: Math.min(Math.max(Number(q.get('partition')) || 0, 0), PARTITIONS - 1),
      scope: SCOPES[q.get('scope') ?? ''] ?? SCOPES.internet,
      size: Number(q.get('size')) || 1,
    }),
};

const server = Bun.serve({
  port: Number(process.env.PORT) || 8080,
  async fetch(req) {
    const url = new URL(req.url);
    const route = routes[url.pathname];
    if (route) {
      try {
        return Response.json(await route(url.searchParams));
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 502 });
      }
    }
    if (url.pathname === '/healthz') return new Response('ok');
    if (url.pathname === '/') return new Response(Bun.file(`${import.meta.dir}/../public/index.html`));
    return new Response('Not Found', { status: 404 });
  },
});

console.log(`listening on ${server.url}`);
