import { readFileSync } from 'node:fs';
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const common = {
  bundle: true,
  sourcemap: true,
  minify: !watch,
  target: 'es2023',
  logLevel: 'info',
  // The Kaitai runtime falls back to these for encodings/zlib; we supply fflate and TextDecoder.
  external: ['vscode', 'zlib', 'iconv-lite'],
};

const targets = [
  // Desktop / code-server extension host (Node).
  { ...common, entryPoints: ['src/extension.ts'], platform: 'node', format: 'cjs', outfile: 'dist/node/extension.js' },
  // VS Code for the Web extension host (web worker).
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    platform: 'browser',
    format: 'cjs',
    outfile: 'dist/web/extension.js',
  },
  // `kaitai` CLI and MCP server, published to npm from npm/ and also run by the desktop extension.
  {
    ...common,
    entryPoints: ['src/agent/main.ts'],
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: 'npm/dist/kaitai.cjs',
    // Not shipped in either package; keeps the .vsix small.
    sourcemap: false,
    external: ['iconv-lite'],
    banner: { js: '#!/usr/bin/env node' },
    define: {
      __KAITAI_CLI_VERSION__: JSON.stringify(JSON.parse(readFileSync('npm/package.json', 'utf8')).version),
    },
  },
  // Webviews (browser, no vscode module).
  {
    ...common,
    entryPoints: { hex: 'src/webview/hex/main.ts', inspector: 'src/webview/inspector/main.ts' },
    platform: 'browser',
    format: 'iife',
    outdir: 'dist/webview',
    loader: { '.css': 'css' },
  },
];

if (watch) {
  for (const t of targets) await (await esbuild.context(t)).watch();
} else {
  await Promise.all(targets.map((t) => esbuild.build(t)));
}
