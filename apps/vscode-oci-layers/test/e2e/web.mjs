// Drives VS Code for the Web through the full flow: open image -> edit -> commit -> push.
// Prereqs: `npx vscode-test-web --browserType=none --extensionDevelopmentPath=. --port 3000`
// and a CORS-enabled registry (see README) holding SOURCE.
// Usage: node test/e2e/web.mjs [screenshotDir]
import { launch, step } from './helpers.mjs';

const SOURCE = process.env.SOURCE ?? 'localhost:5000/library/alpine:3.20';
const TARGET = process.env.TARGET ?? 'localhost:5000/edited/alpine:web';
const { page, shot, answer, openWorkbench, openImage, run } = await launch(process.argv[2]);

await run(async () => {
  await openWorkbench();
  step('open image (the extension host restarts when the first folder is added)');
  await openImage(SOURCE);
  await page.keyboard.press('Control+Shift+E');
  const etc = page.getByRole('treeitem', { name: 'etc', exact: true });
  await etc.waitFor({ timeout: 90_000 });
  await etc.click();
  await page.getByRole('treeitem', { name: 'motd', exact: true }).click();
  await page.locator('.monaco-editor .view-lines').first().waitFor();
  await page.waitForTimeout(1000);
  await shot('1-explorer');

  step('edit /etc/motd and save');
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nEdited in VS Code for the Web.\n');
  await page.keyboard.press('Control+S');
  await page.waitForTimeout(1000);

  step('delete /etc/issue from the explorer');
  await page.getByRole('treeitem', { name: 'issue', exact: true }).click();
  await page.keyboard.press('Delete');
  const confirm = page.getByRole('button', { name: /^(Delete|Move to Trash)$/ });
  if (await confirm.isVisible({ timeout: 3000 }).catch(() => false)) await confirm.click();
  await page.waitForTimeout(1000);

  step('reload the page: pending edits must survive (they live in globalState)');
  await page.reload();
  // test-web does not persist untitled workspaces, so the folder is gone: the extension offers to reopen it.
  const reopen = page
    .locator('.notifications-toasts', { hasText: 'uncommitted changes' })
    .getByRole('button', { name: 'Reopen' });
  await reopen.click({ timeout: 60_000 });
  await page.locator('.statusbar', { hasText: SOURCE }).waitFor({ timeout: 90_000 });

  step('open the Source Control view and the diff');
  await page.keyboard.press('Control+Shift+G');
  const change = page.locator('.scm-view .monaco-list-row', { hasText: 'motd' }).first();
  await change.waitFor({ timeout: 10_000 });
  await change.click();
  await page.locator('.monaco-diff-editor').first().waitFor({ timeout: 10_000 });
  await page.waitForTimeout(1500);
  await shot('2-scm-diff');

  step('commit with Ctrl+Enter and push');
  const input = page.locator('.scm-editor .monaco-editor').first();
  await input.click();
  await page.keyboard.type('Add a web-edited motd');
  await page.keyboard.press('Control+Enter');
  await answer('Push to', TARGET);
  const done = page.locator('.notifications-toasts', { hasText: 'Pushed' });
  await done.waitFor({ timeout: 60_000 });
  await page.waitForTimeout(500);
  await shot('4-pushed');
  console.log(await done.innerText());

  step('layers view shows the new layer');
  const header = page.locator('.pane-header', { hasText: 'Image Layers' });
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
  const layer = page.locator('.monaco-list-row', { hasText: 'Add a web-edited motd' });
  await layer.first().waitFor({ timeout: 10_000 });
  await shot('5-layers');
});
