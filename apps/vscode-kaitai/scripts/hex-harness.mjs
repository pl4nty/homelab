// Renders the hex webview in headless Chromium against the real engine and saves screenshots.
// Usage: node scripts/hex-harness.mjs <out-dir> [spec.ksy sample.bin]
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import * as esbuild from 'esbuild';

// Prefer a Playwright whose browsers are installed (PLAYWRIGHT_MODULE), else the local one.
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE ?? 'playwright');

const out = resolve(process.argv[2] ?? 'hex-harness-out');
const specPath = process.argv[3];
const samplePath = process.argv[4];
mkdirSync(out, { recursive: true });
const specs = {};
if (specPath) {
  const dir = dirname(specPath);
  for (const f of ['icc_4', 'exif']) {
    try {
      specs[f] = readFileSync(join(dir, `${f}.ksy`), 'utf8');
    } catch {}
  }
}
await esbuild.build({
  entryPoints: ['scripts/hex-harness.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  outfile: join(out, 'harness.js'),
  external: ['zlib', 'iconv-lite'],
  define: { SPECS: JSON.stringify(specs), MAIN: JSON.stringify(specPath ? readFileSync(specPath, 'utf8') : '') },
  logLevel: 'warning',
});
copyFileSync('dist/webview/hex.js', join(out, 'hex.js'));
copyFileSync('dist/webview/hex.css', join(out, 'hex.css'));
const theme = process.env.THEME ?? 'dark';
const palette =
  theme === 'light'
    ? { background: '#ffffff', foreground: '#3b3b3b', selectionBackground: '#add6ff', focus: '#005fb8' }
    : { background: '#1f1f1f', foreground: '#cccccc', selectionBackground: '#264f78', focus: '#0078d4' };
const vars = [
  `--vscode-editor-background:${palette.background}`,
  `--vscode-editor-foreground:${palette.foreground}`,
  `--vscode-editor-selectionBackground:${palette.selectionBackground}`,
  `--vscode-focusBorder:${palette.focus}`,
  '--vscode-editorLineNumber-foreground:#6e7681',
  '--vscode-editorError-foreground:#f85149',
  '--vscode-editor-font-family:monospace',
  '--vscode-editor-font-size:13px',
  '--vscode-font-size:13px',
].join(';');
writeFileSync(
  join(out, 'index.html'),
  [
    `<!DOCTYPE html><html style="${vars}"><head><link rel="stylesheet" href="hex.css"></head>`,
    `<body class="vscode-${theme}"><div id="app" tabindex="0"></div><script src="harness.js"></script></body></html>`,
  ].join(''),
);
const sample = samplePath ? [...readFileSync(samplePath)] : Number(process.env.SIZE ?? 4096);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(`file://${join(out, 'index.html')}`);
await page.evaluate((s) => window.boot(s), sample);
await page.waitForTimeout(400);
await page.screenshot({ path: join(out, '1-initial.png') });
// Click a byte, shift-click to extend, hover for the tooltip.
const box = await page.locator('.scroller').boundingBox();
await page.mouse.click(box.x + 150, box.y + 60);
await page.keyboard.down('Shift');
await page.mouse.click(box.x + 400, box.y + 120);
await page.keyboard.up('Shift');
await page.mouse.move(box.x + 250, box.y + 100);
await page.waitForTimeout(200);
await page.screenshot({ path: join(out, '2-select-hover.png') });
await page.mouse.dblclick(box.x + 300, box.y + 160);
await page.keyboard.press('n');
await page.waitForTimeout(200);
await page.screenshot({ path: join(out, '3-next-gap.png') });
for (let i = 0; i < 3; i++) await page.keyboard.press(']');
await page.waitForTimeout(100);
await page.keyboard.press('Control+End');
await page.waitForTimeout(200);
await page.screenshot({ path: join(out, '4-end.png') });
// Drag-like scrollbar jump to the middle, then wheel by real pixels.
await page.evaluate(() => {
  const s = document.querySelector('.scroller');
  s.scrollTop = (s.scrollHeight - s.clientHeight) / 2;
});
await page.waitForTimeout(100);
await page.mouse.move(box.x + 200, box.y + 200);
await page.mouse.wheel(0, 60);
await page.waitForTimeout(200);
await page.screenshot({ path: join(out, '5-middle-wheel.png') });
// Host-driven: select and reveal a range, outline another across rows, then change the row width.
await page.evaluate(() => {
  window.toWebview({ type: 'select', start: 40, end: 60, reveal: true });
  window.toWebview({ type: 'highlight', start: 70, end: 130 });
});
await page.waitForTimeout(200);
await page.screenshot({ path: join(out, '6-select-highlight.png') });
await page.evaluate(() => window.toWebview({ type: 'config', bytesPerRow: 32 }));
await page.waitForTimeout(200);
await page.screenshot({ path: join(out, '7-wide.png') });
const log = await page.evaluate(() => window.hostLog.filter((m) => m.type !== 'requestRegions'));
const state = await page.evaluate(() => window.savedState);
writeFileSync(join(out, 'log.json'), JSON.stringify({ errors, log, state }, null, 1));
console.log(JSON.stringify({ errors, messages: log.length, last: log.slice(-4) }));
await browser.close();
