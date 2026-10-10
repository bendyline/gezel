/**
 * Write flow — the real interactive round-trip through the composer (not the
 * seed): type a unique message, send it, and assert the mock provider's reply
 * renders. Proves the UI → service → SSE → render path end to end.
 *
 * No gallery shots here — this is a behavior assertion. (It adds one exchange to
 * the meester timeline; the gallery is regenerated per run so that's benign.)
 */
import { expect, test } from './fixtures/test.js';
import { gotoMeesterChat } from './helpers/nav.js';

test.use({ daemonGroup: 'write-flow' });

test.describe('write flow', () => {
  test('compose, send, receive a reply', async ({ page }) => {
    await gotoMeesterChat(page);
    const chat = page.getByTestId('meester-chat');
    const composer = chat.getByTestId('chat-composer');
    await expect(composer).toBeVisible();

    const editor = composer.locator('.squisq-wysiwyg-editor').first();
    const msg = 'Ping from the write-flow spec';
    await editor.fill(msg);
    await editor.press('Enter');

    // The mock provider echoes its whole prompt as "Mock reply: <prompt>", and
    // the prompt opens with any indexed context retrieved for the message (the
    // seeded handboek matches "spec"), so the echo and the message are matched
    // separately.
    await expect(
      chat.locator('.msg-assistant').filter({ hasText: 'Mock reply:' }).filter({ hasText: msg }),
    ).toBeVisible({ timeout: 20_000 });
  });

  test('replacing a suggested task with a message sends chat before the next preview arrives', async ({
    page,
  }) => {
    await gotoMeesterChat(page);
    const chat = page.getByTestId('meester-chat');
    const composer = chat.getByTestId('chat-composer');
    const editor = composer.locator('.squisq-wysiwyg-editor').first();
    await editor.fill('Draft a launch plan for the landing page');
    await expect(composer.getByRole('group', { name: /attached task/i })).toBeVisible();

    let releasePreview!: () => void;
    const previewHeld = new Promise<void>((resolve) => {
      releasePreview = resolve;
    });
    await page.route('**/api/sessions/turn-intent-preview', async (route) => {
      await previewHeld;
      await route.continue();
    });
    const msg = 'Ping after replacing the suggested task';
    try {
      await editor.fill(msg);
      await editor.press('Enter');
      await expect(
        chat.locator('.msg-assistant').filter({ hasText: 'Mock reply:' }).filter({ hasText: msg }),
      ).toBeVisible({ timeout: 20_000 });
    } finally {
      releasePreview();
      await page.unrouteAll({ behavior: 'wait' });
    }
  });
});
