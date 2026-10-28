// Quick Open and Search view over an image. SOURCE must hold zstd layers, e.g.:
//   docker buildx build --output type=image,name=localhost:5000/zstd/alpine:latest,push=true,compression=zstd,force-compression=true,oci-mediatypes=true,registry.insecure=true <ctx>
// Uses the proposed search APIs, which need extension development mode on Insiders
// (`vscode-test-web --quality insiders --extensionDevelopmentPath=.`). With FALLBACK=1 (any
// quality), checks the stable "Find … in Image" commands instead.
// Usage: node test/e2e/search.mjs [screenshotDir]
import { launch, step } from './helpers.mjs';

const SOURCE = process.env.SOURCE ?? 'localhost:5000/zstd/alpine:latest';
const { page, shot, answer, command, openWorkbench, openImage, run } = await launch(process.argv[2]);

await run(async () => {
  await openWorkbench();
  step(`open ${SOURCE} (zstd-compressed layers)`);
  await openImage(SOURCE);

  if (process.env.FALLBACK) {
    step('Find File in Image');
    await command('OCI Layers: Find File in Image');
    await answer('Find file in', 'zstd-marker');
    await page.locator('.tab', { hasText: 'zstd-marker' }).waitFor({ timeout: 10_000 });
    step('Find Text in Image');
    await command('OCI Layers: Find Text in Image');
    await answer('Find text in', 'built with zstd');
    await page
      .locator('.quick-input-list .monaco-list-row', { hasText: 'zstd-marker' })
      .first()
      .waitFor({ timeout: 10_000 });
    await shot('fallback-find-text');
    await page.keyboard.press('Enter');
    console.log('fallback commands OK');
    return;
  }

  step('Quick Open (Ctrl+P) finds a file by fuzzy name');
  await page.keyboard.press('Control+P');
  await page.waitForTimeout(500);
  await page.keyboard.type('zstdmark');
  const row = page.locator('.quick-input-list .monaco-list-row', { hasText: 'zstd-marker' }).first();
  await row.waitFor({ timeout: 20_000 });
  await shot('quick-open');
  await page.keyboard.press('Enter');
  await page.locator('.monaco-editor .view-lines', { hasText: 'built with zstd' }).first().waitFor({ timeout: 10_000 });

  step('Search view (Ctrl+Shift+F) finds text across the image');
  await page.keyboard.press('Control+Shift+F');
  await page.waitForTimeout(500);
  await page.keyboard.type('ttyS0');
  await page.keyboard.press('Enter');
  const result = page.locator('.search-view .monaco-list-row', { hasText: 'inittab' }).first();
  await result.waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1000);
  await shot('search-view');
  console.log(
    (
      await page
        .locator('.search-view .result-messages, .search-view .message')
        .first()
        .innerText()
        .catch(() => '')
    ).trim(),
  );
  await page.locator('.search-view .monaco-list-row', { hasText: 'respawn' }).first().click();
  await page.locator('.monaco-editor .view-lines', { hasText: 'ttyS0' }).first().waitFor({ timeout: 10_000 });
  console.log('search OK');
});
