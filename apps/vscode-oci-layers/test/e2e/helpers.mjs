import { chromium } from 'playwright-core';

export async function launch(shots) {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const shot = async (name) => {
    if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
  };

  /** Type into the quick input once it shows `hint` (fill() is lost while the widget re-renders). */
  async function answer(hint, value) {
    await page.locator('.quick-input-widget', { hasText: hint }).waitFor();
    await page.waitForTimeout(1000);
    await page.locator('.quick-input-widget input').first().focus();
    await page.keyboard.press('Control+A');
    await page.keyboard.type(value);
    await page.keyboard.press('Enter');
  }

  async function command(title) {
    await page.keyboard.press('F1');
    await page.locator('.quick-input-widget input').fill(`>${title}`);
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
  }

  async function openWorkbench(url = process.env.VSCODE_URL ?? 'http://localhost:3000') {
    await page.goto(url);
    await page.locator('.monaco-workbench').waitFor({ timeout: 60_000 });
    await page.waitForTimeout(3000);
  }

  async function openImage(ref) {
    await command('OCI Layers: Open Image');
    await answer('Image reference', ref);
    await page.locator('.statusbar', { hasText: ref }).waitFor({ timeout: 90_000 });
  }

  /** Run `body`; on failure save a screenshot and print console errors. */
  async function run(body) {
    try {
      await body();
      if (errors.length) console.log(`console errors:\n${errors.filter((e) => /oci|layer/i.test(e)).join('\n')}`);
    } catch (e) {
      await shot('failure').catch(() => undefined);
      console.log(`console errors:\n${errors.join('\n')}`);
      throw e;
    } finally {
      await browser.close();
    }
  }

  return { browser, page, errors, shot, answer, command, openWorkbench, openImage, run };
}

export const step = (s) => console.log(`- ${s}`);
