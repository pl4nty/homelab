// CORS proxy for OCI registries, for VS Code for the Web. Cloudflare Workers module syntax;
// also runs under Bun (see serve.mjs). Set "ociLayers.corsProxy": "https://<worker host>/".
//
// Requests look like https://<worker>/https://ghcr.io/v2/... . The worker:
// - only answers allowed browser origins and only forwards to allowed registry hosts (not an open relay)
// - answers CORS preflights itself (registries return 401/405 to OPTIONS)
// - follows GET/HEAD redirects to blob CDNs server-side, dropping Authorization on cross-host hops
// - exposes WWW-Authenticate, Location and Docker-Content-Digest to the extension
// It sees registry credentials and tokens: deploy your own, never use someone else's.
//
// Override the allowlists with comma-separated regexes in env ALLOWED_ORIGINS / ALLOWED_HOSTS.

const DEFAULT_HOSTS = [
  'registry-1\\.docker\\.io',
  'auth\\.docker\\.io',
  'mirror\\.gcr\\.io',
  'ghcr\\.io',
  'quay\\.io',
  'public\\.ecr\\.aws',
  '(.+\\.)?gcr\\.io',
  '.+-docker\\.pkg\\.dev',
  'registry\\.gitlab\\.com',
  'gitlab\\.com',
  'mcr\\.microsoft\\.com',
  'registry\\.k8s\\.io',
  'cgr\\.dev',
  'nvcr\\.io',
  'ttl\\.sh',
  '.+\\.azurecr\\.io',
];
const DEFAULT_ORIGINS = [
  'https://([a-z0-9-]+\\.)*vscode-cdn\\.net',
  'https://(insiders\\.)?vscode\\.dev',
  'https://github\\.dev',
];
const EXPOSE =
  'WWW-Authenticate, Location, Docker-Content-Digest, Docker-Upload-UUID, Docker-Distribution-API-Version, Range, Link, Content-Length, Content-Range, OCI-Subject';
const FORWARD = ['authorization', 'accept', 'content-type', 'content-range', 'range', 'docker-content-digest'];

const compile = (list) => list.map((s) => new RegExp(`^${s.trim()}$`));
const cache = new Map();
function allowlist(env, key, fallback) {
  const src = env?.[key] ?? '';
  if (!cache.has(key + src)) cache.set(key + src, compile(src ? src.split(',') : fallback));
  return cache.get(key + src);
}

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
    // A "*" wildcard never covers Authorization, so list it explicitly.
    'Access-Control-Allow-Headers': 'Authorization, Accept, Content-Type, Content-Range, Range, Docker-Content-Digest',
    'Access-Control-Expose-Headers': EXPOSE,
    'Access-Control-Max-Age': '86400',
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') ?? '';
    if (!allowlist(env, 'ALLOWED_ORIGINS', DEFAULT_ORIGINS).some((r) => r.test(origin))) {
      return new Response('origin not allowed', { status: 403 });
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });

    const self = new URL(request.url);
    let target;
    try {
      target = new URL(self.pathname.slice(1) + self.search);
    } catch {
      return new Response('expected /<absolute registry URL>', { status: 400, headers: cors(origin) });
    }
    if (
      target.protocol !== 'https:' ||
      !allowlist(env, 'ALLOWED_HOSTS', DEFAULT_HOSTS).some((r) => r.test(target.hostname))
    ) {
      return new Response(`host not allowed: ${target.hostname}`, { status: 403, headers: cors(origin) });
    }

    const headers = new Headers();
    for (const k of FORWARD) if (request.headers.has(k)) headers.set(k, request.headers.get(k));
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    let res = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: 'manual',
      duplex: 'half',
    });
    for (let i = 0; i < 5 && !hasBody && [301, 302, 303, 307, 308].includes(res.status); i++) {
      const next = new URL(res.headers.get('Location'), target);
      // the hop isn't allowlisted (blob CDNs vary), so at least keep it off plain http, which
      // is how a redirect would reach cluster-internal services from the in-cluster proxy
      if (next.protocol !== 'https:') break;
      const h = new Headers(headers);
      if (next.host !== target.host) h.delete('authorization'); // presigned CDN URLs reject extra auth
      target = next;
      res = await fetch(target, { method: request.method, headers: h, redirect: 'manual' });
    }

    const out = new Headers(res.headers);
    // Make Location absolute against the upstream; the extension re-applies the proxy prefix itself.
    const loc = out.get('Location');
    if (loc) out.set('Location', new URL(loc, target).toString());
    for (const [k, v] of Object.entries(cors(origin))) out.set(k, v);
    out.delete('set-cookie');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
  },
};
