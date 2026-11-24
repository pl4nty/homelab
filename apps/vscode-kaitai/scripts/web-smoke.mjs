// Browser smoke test for the web extension, against a running `vscode-test-web` (see `npm run serve:web`).
//   node scripts/web-smoke.mjs [url] [--channel msedge|chrome] [--headed]
// Opens test/fixtures/sample.png in the Kaitai Hex Editor, loads image/png.ksy, and prints what each view shows.
// Screenshots go to test/fixtures/_smoke/, which test-web also serves at /static/mount/_smoke/.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const url = args.find((a) => /^https?:/.test(a)) ?? 'http://localhost:3000';
const channel = args.includes('--channel') ? args[args.indexOf('--channel') + 1] : 'msedge';
const outDir = join(import.meta.dirname, '..', 'test', 'fixtures', '_smoke');
mkdirSync(outDir, { recursive: true });

const report = [];
const log = (step, detail) => {
  report.push({ step, detail });
  console.log(`## ${step}\n${typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)}\n`);
};
const consoleLines = [];

const browser = await chromium.launch({ channel, headless: !args.includes('--headed') });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('console', (m) => {
  if (m.type() === 'error' || /kaitai/i.test(m.text())) consoleLines.push(`[${m.type()}] ${m.text().slice(0, 400)}`);
});
page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`));
page.on('worker', (w) => consoleLines.push(`[worker] ${w.url().slice(0, 120)}`));

let shot = 0;
const snap = async (name) => {
  const file = `${String(++shot).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: join(outDir, file) });
  return file;
};
const pause = (ms) => page.waitForTimeout(ms);

async function runCommand(title) {
  await page.keyboard.press('F1');
  await page.locator('.quick-input-widget input').fill(`>${title}`);
  await pause(600);
  await page.keyboard.press('Enter');
  await pause(800);
}

/** Opens a workspace file from the Explorer (quick open needs a file search provider, which test-web lacks). */
async function openFromExplorer(...path) {
  await page.keyboard.press('Control+Shift+E');
  const tree = page.locator('.explorer-folders-view');
  for (const [i, name] of path.entries()) {
    const row = tree.locator('.monaco-list-row', { has: page.getByText(name, { exact: true }) }).first();
    await row.waitFor({ timeout: 15000 });
    if (i < path.length - 1) {
      if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
    } else await row.dblclick();
    await pause(500);
  }
}

const rows = (selector) =>
  page.$$eval(selector, (els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent?.trim()).filter(Boolean));
const viewRows = (title) =>
  page.evaluate((t) => {
    const pane = [...document.querySelectorAll('.pane')].find((p) =>
      p.querySelector('.pane-header')?.textContent?.toLowerCase().includes(t),
    );
    if (!pane) return ['<view not found>'];
    const list = [...pane.querySelectorAll('.monaco-list-row')].map(
      (r) => r.getAttribute('aria-label') ?? r.textContent,
    );
    return list.length ? list : [pane.querySelector('.pane-body')?.textContent?.trim().slice(0, 300) ?? ''];
  }, title.toLowerCase());
const notifications = () => rows('.notification-toast .notification-list-item-message');

async function step(name, fn) {
  try {
    await fn();
  } catch (e) {
    log(`${name}: FAILED`, String(e?.message ?? e).split('\n')[0]);
    await snap(`${name.replace(/\W+/g, '-')}-failed`).catch(() => {});
  }
}

await step('load workbench', async () => {
  await page.goto(url);
  await page.locator('.monaco-workbench').waitFor({ timeout: 60000 });
  await page.locator('.explorer-folders-view .monaco-list-row').first().waitFor({ timeout: 60000 });
  log('load workbench', {
    explorer: await rows('.explorer-folders-view .monaco-list-row'),
    shot: await snap('workbench'),
  });
});

await step('open sample.png in hex editor', async () => {
  await openFromExplorer('sample.png');
  await pause(1500);
  await runCommand('Kaitai: Open in Kaitai Hex Editor');
  await page.locator('iframe.webview').first().waitFor({ timeout: 20000 });
  await pause(3000);
  log('open sample.png in hex editor', {
    tabs: await rows('.tabs-container .tab'),
    notifications: await notifications(),
    structure: await viewRows('structure'),
    shot: await snap('hex-editor'),
  });
});

await step('load png.ksy', async () => {
  await runCommand('Kaitai: Load Spec…');
  await page.locator('.quick-input-widget input').fill('png.ksy');
  await pause(1500);
  const picks = await rows('.quick-input-list .monaco-list-row');
  await page.keyboard.press('Enter');
  await pause(5000);
  log('load png.ksy', {
    picks,
    notifications: await notifications(),
    structure: await viewRows('structure'),
    statusBar: await rows('.statusbar-item'),
    shot: await snap('png-parsed'),
  });
});

await step('select first tree node', async () => {
  const pane = page.locator('.pane', { has: page.locator('.pane-header', { hasText: /structure/i }) });
  await pane.locator('.monaco-list-row').nth(1).click();
  await pause(1500);
  log('select first tree node', {
    inspector: await viewRows('inspector'),
    statusBar: await rows('.statusbar-item'),
    shot: await snap('selected'),
  });
});

await step('png.ksy language features', async () => {
  await openFromExplorer('image', 'png.ksy');
  await pause(3000);
  log('png.ksy language features', {
    languageStatus: await rows('.statusbar-item'),
    outline: await viewRows('outline'),
    shot: await snap('ksy-editor'),
  });
});

await step('format gallery', async () => {
  await runCommand('Kaitai: Refresh');
  await pause(6000);
  log('format gallery', {
    gallery: (await viewRows('format gallery')).slice(0, 15),
    notifications: await notifications(),
  });
  await snap('gallery');
});

log('console (errors and kaitai lines)', consoleLines.slice(-60).join('\n'));
await browser.close();
