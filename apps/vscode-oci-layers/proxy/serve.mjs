// `bun proxy/serve.mjs [port]`: the proxy at /<absolute registry URL>, and the web extension
// from PUBLIC_DIR (if set) so vscode.dev can "Install Extension from Location" from the same host.
// Env ALLOWED_ORIGINS / ALLOWED_HOSTS override the allowlists; HOST sets the bind address.
// With OTEL_EXPORTER_OTLP_ENDPOINT set it sends traces (needs `bun install` in proxy/ first).
import worker from './worker.js';

const { traced } = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? await import('./otel.mjs') : { traced: (f) => f };

const port = Number(process.argv[2] ?? 8787);
const { HOST = '127.0.0.1', PUBLIC_DIR } = process.env;

Bun.serve({
  port,
  hostname: HOST,
  fetch: traced(async (req) => {
    const { pathname } = new URL(req.url);
    if (!PUBLIC_DIR || /^\/https?:/.test(pathname)) return worker.fetch(req, process.env);
    const file = Bun.file(PUBLIC_DIR + pathname);
    if (!(await file.exists())) return new Response('not found', { status: 404 });
    return new Response(file, { headers: { 'Access-Control-Allow-Origin': '*' } });
  }),
});
console.log(`OCI CORS proxy on http://${HOST}:${port}/`);
