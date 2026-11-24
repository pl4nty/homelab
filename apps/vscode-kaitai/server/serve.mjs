// `bun server/serve.mjs [port]`: serves the web extension from PUBLIC_DIR with CORS, so vscode.dev
// can "Install Extension from Location" from this host. HOST sets the bind address.
import { join, normalize } from 'node:path';

const port = Number(process.argv[2] ?? 8787);
const { HOST = '127.0.0.1', PUBLIC_DIR = '.' } = process.env;
// Allow-Private-Network answers Chrome's preflight when a public page (vscode.dev) fetches from localhost.
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Private-Network': 'true',
  // Webview frames are cross-origin isolated and reject files without CORP.
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Cache-Control': 'no-cache',
};

Bun.serve({
  port,
  hostname: HOST,
  async fetch(req) {
    if (req.method === 'OPTIONS')
      return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Headers': '*' } });
    const path = normalize(decodeURIComponent(new URL(req.url).pathname)).replace(/^(\.\.[/\\])+/, '');
    if (path === '/healthz') return new Response('ok');
    const file = Bun.file(join(PUBLIC_DIR, path === '/' ? 'README.md' : path));
    if (!(await file.exists())) return new Response('not found', { status: 404, headers: cors });
    return new Response(file, { headers: cors });
  },
});
console.log(`Kaitai IDE web extension on http://${HOST}:${port}/`);
