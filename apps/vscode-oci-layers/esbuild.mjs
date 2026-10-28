import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const common = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  external: ['vscode'],
  sourcemap: true,
  minify: !watch,
  target: 'es2022',
  logLevel: 'info',
};

const targets = [
  // Desktop / code-server / openvscode-server extension host (Node).
  { ...common, platform: 'node', format: 'cjs', outfile: 'dist/node/extension.js' },
  // VS Code for the Web extension host (web worker).
  { ...common, platform: 'browser', format: 'cjs', outfile: 'dist/web/extension.js' },
];

if (watch) {
  for (const t of targets) await (await esbuild.context(t)).watch();
} else {
  await Promise.all(targets.map((t) => esbuild.build(t)));
}
