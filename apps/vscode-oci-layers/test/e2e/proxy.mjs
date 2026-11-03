// Public registries from VS Code for the Web through the CORS worker (proxy/worker.js):
// anonymous pull from SOURCE, edit, then push to TARGET (ttl.sh accepts anonymous pushes).
// Prereqs: test-web on :3000 and `ALLOWED_ORIGINS='http://([a-z0-9-]+\.)?localhost:\d+' bun proxy/serve.mjs 8787`
// (the web extension host runs on a per-extension subdomain, http://v--<hash>.localhost:3000 here
// and https://v--<hash>.vscode-cdn.net on vscode.dev).
// Usage: node test/e2e/proxy.mjs [screenshotDir]
import { launch, step } from './helpers.mjs';

const PROXY = process.env.PROXY ?? 'http://127.0.0.1:8787/';
const SOURCE = process.env.SOURCE ?? 'ghcr.io/linuxcontainers/alpine:3.20';
const TARGET = process.env.TARGET ?? `ttl.sh/oci-layers-e2e-${Date.now()}:1h`;
const { page, shot, answer, command, openWorkbench, openImage, run } = await launch(process.argv[2]);

await run(async () => {
  await openWorkbench();

  step('without a proxy, opening a public image fails with a CORS hint');
  await command('OCI Layers: Open Image');
  await answer('Image reference', SOURCE);
  const err = page.locator('.notifications-toasts', { hasText: 'cannot reach' });
  await err.waitFor({ timeout: 30_000 });
  await shot('proxy-1-cors-error');
  console.log(`  ${await err.locator('.notification-list-item-message').first().innerText()}`);

  step(`set ociLayers.corsProxy = ${PROXY} via "Configure Proxy"`);
  await err.getByRole('button', { name: 'Configure Proxy' }).click();
  const input = page.locator('.settings-editor .setting-item-contents', { hasText: 'Cors Proxy' }).locator('input');
  await input.waitFor({ timeout: 15_000 });
  await input.fill(PROXY);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(1000);
  await shot('proxy-settings');
  await page.keyboard.press('Control+W'); // close Settings so F1 reaches the workbench
  await page.waitForTimeout(500);

  step(`open ${SOURCE} through the proxy`);
  await openImage(SOURCE);
  await page.keyboard.press('Control+Shift+E');
  await page.getByRole('treeitem', { name: 'etc', exact: true }).click();
  await page.getByRole('treeitem', { name: 'motd', exact: true }).click();
  await page.locator('.monaco-editor .view-lines', { hasText: 'Alpine' }).first().waitFor({ timeout: 10_000 });
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nPushed through the CORS worker.\n');
  await page.keyboard.press('Control+S');
  await page.waitForTimeout(1000);

  step(`commit and push to ${TARGET}`);
  await page.keyboard.press('Control+Shift+G');
  await page.locator('.scm-editor .monaco-editor').first().click();
  await page.keyboard.type('via worker');
  await page.keyboard.press('Control+Enter');
  await answer('Push to', TARGET);
  const done = page.locator('.notifications-toasts', { hasText: 'Pushed' });
  await done.waitFor({ timeout: 120_000 });
  await shot('proxy-2-pushed');
  console.log(`  ${await done.locator('.notification-list-item-message').first().innerText()}`);
  console.log(`TARGET=${TARGET}`);
});
