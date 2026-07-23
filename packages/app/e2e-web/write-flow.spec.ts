/**
 * Write flow — the real interactive round-trip through the composer (not the
 * seed): type a unique message, send it, and assert the mock provider's reply
 * renders. Proves the UI → service → SSE → render path end to end.
 *
 * No gallery shots here — this is a behavior assertion. (It adds one exchange to
 * the meester timeline; the gallery is regenerated per run so that's benign.)
 */
import { expect, test } from './fixtures/test.js';
import { gotoHome } from './helpers/nav.js';

test.describe('write flow', () => {
  test('compose, send, receive a reply', async ({ page }) => {
    await gotoHome(page);
    const chat = page.getByTestId('meester-chat');
    const composer = chat.getByTestId('chat-composer');
    await expect(composer).toBeVisible();

    const editor = composer.locator('.squisq-wysiwyg-editor').first();
    await editor.click();
    const msg = 'Ping from the write-flow spec';
    await page.keyboard.type(msg);
    await page.keyboard.press('Enter');

    // The mock provider echoes "Mock reply: <prompt>".
    await expect(
      chat.locator('.msg-assistant').filter({ hasText: `Mock reply: ${msg}` }),
    ).toBeVisible({ timeout: 20_000 });
  });
});
