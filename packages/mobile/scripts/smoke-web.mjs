import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// The workspace UI owns the shared browser testing toolchain.
const { chromium } = createRequire(new URL('../../ui/package.json', import.meta.url))('playwright');
const url = process.argv[2] ?? 'http://127.0.0.1:4178';
const screenshots = process.argv[3];
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.getByRole('navigation', { name: 'Primary navigation', exact: true }).waitFor();
  if (!(await page.getByRole('button', { name: 'Documents', exact: true }).isDisabled())) {
    throw new Error('Native document capability must not be advertised before it exists');
  }
  if (screenshots) {
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: resolve(screenshots, 'phone-navigation.png') });
  }
  async function enterProject(target) {
    await target
      .getByRole('navigation', { name: 'Primary navigation', exact: true })
      .getByRole('button', { name: 'My space', exact: true })
      .click();
    await target.getByRole('heading', { name: 'Mira', exact: true }).waitFor();
  }
  await enterProject(page);
  const sendBounds = await page.getByRole('button', { name: 'Send', exact: true }).boundingBox();
  if (!sendBounds || sendBounds.y + sendBounds.height > page.viewportSize().height) {
    throw new Error('The project composer must fit within the phone viewport');
  }
  await page.getByRole('button', { name: 'Choose a model', exact: true }).click();
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Navigation', exact: true }).click();
  await enterProject(page);
  const staleTab = await page.context().newPage();
  await staleTab.goto(url);
  await enterProject(staleTab);
  if (screenshots) {
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: resolve(screenshots, 'phone.png') });
  }
  await page.getByRole('button', { name: 'Conversations', exact: true }).click();
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('button', { name: 'Conversations', exact: true }).waitFor();
  // An older preview tab must not overwrite the newly saved conversation.
  await staleTab.getByRole('button', { name: 'Conversations', exact: true }).click();
  await staleTab.getByRole('button', { name: 'New', exact: true }).click();
  await staleTab
    .getByRole('alert')
    .filter({ hasText: 'changed in another preview tab' })
    .waitFor({ state: 'attached' });
  await staleTab.close();
  await page.reload();
  await enterProject(page);
  await page.getByRole('button', { name: 'Conversations', exact: true }).click();
  const count = await page.getByRole('button', { name: 'New conversation', exact: true }).count();
  if (count !== 2) throw new Error('The new conversation did not survive reload');
  await page.getByText('Manage this conversation', { exact: true }).click();
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Conversation name', exact: true })
    .fill('Mobile recovery notes');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await page.getByRole('button', { name: 'Mobile recovery notes', exact: true }).waitFor();
  await page.getByRole('searchbox', { name: 'Search conversations', exact: true }).fill('recovery');
  if (
    (await page
      .getByRole('navigation', { name: 'Conversations', exact: true })
      .getByRole('button')
      .count()) !== 1
  ) {
    throw new Error('Conversation search did not filter by the saved title');
  }
  await page.reload();
  await enterProject(page);
  if (!(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled())) {
    throw new Error('Browser preview must fail closed without an available provider');
  }
  await page.getByRole('button', { name: 'Conversations', exact: true }).click();
  await page.getByRole('button', { name: 'Mobile recovery notes', exact: true }).waitFor();
  await page.getByText('Manage this conversation', { exact: true }).click();
  await page.getByRole('button', { name: 'Delete conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Keep conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Mobile recovery notes', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Delete conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await page
    .getByRole('button', { name: 'Mobile recovery notes', exact: true })
    .waitFor({ state: 'detached' });
  await page.reload();
  await enterProject(page);
  await page.getByRole('button', { name: 'Conversations', exact: true }).click();
  if (
    (await page
      .getByRole('navigation', { name: 'Conversations', exact: true })
      .getByRole('button')
      .count()) !== 1
  ) {
    throw new Error('Conversation deletion did not survive reload');
  }
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) {
    throw new Error('Phone layout overflows horizontally');
  }
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByRole('heading', { name: 'Mira', exact: true }).waitFor();
  if (screenshots) await page.screenshot({ path: resolve(screenshots, 'tablet.png') });
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Mobile phone/tablet worker, layout, and persistence checks passed.');
} finally {
  await browser.close();
}
