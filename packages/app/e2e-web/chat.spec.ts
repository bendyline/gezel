/**
 * Chat surface — the meester conversation on Home carries the seeded exchange
 * (a user message + its mock reply), which doubles as a read-only,
 * order-independent anchor for the timeline, composer, and bubble shots. The
 * interactive send flow is covered by the write-flow spec.
 */
import { expect, test } from './fixtures/test.js';
import { settle } from './helpers/determinism.js';
import { gotoHome } from './helpers/nav.js';
import { shot } from './helpers/shot.js';

test.describe('chat surface', () => {
  test('live tool arguments stay inside the thinking bubble', async ({ page }) => {
    await gotoHome(page);

    // Reproduce the live, tool-only phase from StreamingBubble. In this state
    // `.msg-body` is a column flexbox and every rendered event is wrapped in a
    // `.msg-stream-segment`; a long args summary must size against the bubble,
    // not give that intermediate flex item a max-content width.
    const assistant = page.getByTestId('meester-chat').locator('.msg-assistant').first();
    await expect(assistant).toBeVisible();
    await assistant.evaluate((bubble) => {
      bubble.classList.add('msg-thinking');
      // The project chat becomes this narrow when its output/reference rail is
      // open. Keeping the fixture narrow also ensures the 28rem args cap alone
      // cannot mask an intrinsic-width leak in an ancestor.
      (bubble as HTMLElement).style.width = '22rem';
      (bubble as HTMLElement).style.maxWidth = '22rem';
      const body = bubble.querySelector<HTMLElement>('.msg-body');
      if (!body) throw new Error('seeded assistant bubble has no .msg-body');
      body.replaceChildren();

      const segment = document.createElement('div');
      segment.className = 'msg-stream-segment';
      segment.innerHTML = `
        <ul class="thinking-tools">
          <li class="thinking-tool">
            <span class="thinking-tool-row">
              <span class="thinking-tool-icon">&#10003;</span>
              <span class="thinking-tool-name">make move</span>
              <span class="thinking-tool-args">from: "d6", to: "c5", moveThought: "Central control first; this deliberately long argument summary must ellipsize"</span>
            </span>
            <div class="thinking-tool-detail">
              <button class="thinking-tool-detail-toggle" type="button">details</button>
            </div>
          </li>
        </ul>`;
      body.append(segment);
    });

    const geometry = await assistant.locator('.msg-body').evaluate((body) => {
      const bodyStyle = getComputedStyle(body);
      const bodyRect = body.getBoundingClientRect();
      const contentRight =
        bodyRect.right -
        Number.parseFloat(bodyStyle.borderRightWidth) -
        Number.parseFloat(bodyStyle.paddingRight);
      const segment = body.querySelector<HTMLElement>('.msg-stream-segment');
      const row = body.querySelector<HTMLElement>('.thinking-tool-row');
      const args = body.querySelector<HTMLElement>('.thinking-tool-args');
      if (!segment || !row || !args) throw new Error('tool-call fixture did not render');
      return {
        contentRight,
        segmentRight: segment.getBoundingClientRect().right,
        rowRight: row.getBoundingClientRect().right,
        argsOverflow: getComputedStyle(args).textOverflow,
      };
    });

    expect(geometry.segmentRight).toBeLessThanOrEqual(geometry.contentRight + 0.5);
    expect(geometry.rowRight).toBeLessThanOrEqual(geometry.contentRight + 0.5);
    expect(geometry.argsOverflow).toBe('ellipsis');
  });

  test('composer uses the project-chat frame and keeps only host toolbar actions', async ({
    page,
  }) => {
    await gotoHome(page);

    const chat = page.getByTestId('meester-chat');
    const composer = chat.getByTestId('chat-composer');
    const frame = await composer.evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const railRect = element.parentElement?.getBoundingClientRect();
      const recipient = element.querySelector<HTMLElement>('.chat-composer-to');
      const session = element.querySelector<HTMLElement>('.gezel-chat-session-header');
      const sessionSelect = session?.querySelector<HTMLElement>('.gezel-chat-session-select');
      const editor = element.querySelector<HTMLElement>('.squisq-wysiwyg-editor');
      const toolbar = element.querySelector<HTMLElement>('.squisq-toolbar');
      if (!railRect || !recipient || !session || !sessionSelect || !editor || !toolbar) {
        throw new Error('Meester composer frame fixture did not render');
      }
      const chatPaperProbe = document.createElement('span');
      chatPaperProbe.style.background = 'var(--chat-bubble-bg)';
      element.append(chatPaperProbe);
      const composeHeaderProbe = document.createElement('span');
      composeHeaderProbe.style.background = 'var(--chat-compose-header-bg)';
      element.append(composeHeaderProbe);
      const recipientRect = recipient.getBoundingClientRect();
      const sessionRect = session.getBoundingClientRect();
      const result = {
        background: style.backgroundColor,
        borderWidth: style.borderTopWidth,
        radius: Number.parseFloat(style.borderTopLeftRadius),
        insetLeft: rect.left - railRect.left,
        insetRight: railRect.right - rect.right,
        recipientInside: recipientRect.left >= rect.left && recipientRect.right <= rect.right,
        sessionInside: sessionRect.left >= rect.left && sessionRect.right <= rect.right,
        sessionBackground: getComputedStyle(sessionSelect).backgroundColor,
        chatPaperBackground: getComputedStyle(chatPaperProbe).backgroundColor,
        editorBackground: getComputedStyle(editor).backgroundColor,
        toolbarBackground: getComputedStyle(toolbar).backgroundColor,
        composeHeaderBackground: getComputedStyle(composeHeaderProbe).backgroundColor,
      };
      chatPaperProbe.remove();
      composeHeaderProbe.remove();
      return result;
    });

    expect(frame.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(frame.borderWidth).toBe('1px');
    expect(frame.radius).toBeGreaterThan(0);
    expect(frame.insetLeft).toBeGreaterThan(1);
    expect(frame.insetRight).toBeGreaterThan(1);
    expect(frame.recipientInside).toBe(true);
    expect(frame.sessionInside).toBe(true);
    expect(frame.sessionBackground).toBe(frame.chatPaperBackground);
    expect(frame.background).toBe(frame.composeHeaderBackground);
    expect(frame.toolbarBackground).toBe(frame.composeHeaderBackground);
    expect(frame.editorBackground).not.toBe(frame.composeHeaderBackground);

    await expect(composer.getByRole('toolbar', { name: /toolbar/i })).toBeVisible();
    await expect(composer.getByRole('button', { name: /^Send$/ })).toBeVisible();
    await expect(composer.getByRole('button', { name: /^Bold/ })).toBeHidden();
    await expect(composer.getByRole('button', { name: 'More actions' })).toBeHidden();

    const insert = composer.getByRole('button', { name: 'Insert', exact: true });
    await insert.click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();

    const [triggerBox, menuBox] = await Promise.all([insert.boundingBox(), menu.boundingBox()]);
    expect(triggerBox).not.toBeNull();
    expect(menuBox).not.toBeNull();
    expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(triggerBox!.y - 3);
    expect(menuBox!.y).toBeGreaterThanOrEqual(8);
  });

  test('timeline, composer, bubbles (seeded exchange)', async ({ page }) => {
    await gotoHome(page);
    const chat = page.getByTestId('meester-chat');
    await expect(chat).toBeVisible();

    const timeline = chat.getByTestId('chat-timeline');
    await expect(timeline).toBeVisible();

    // The seed sent a message and the mock provider replied — proves the chat
    // pipeline end-to-end (send → worker → SSE → render) without mutating here.
    const assistant = chat.locator('.msg-assistant').first();
    await expect(assistant).toContainText('Mock reply', { timeout: 15_000 });

    await shot(page, 'timeline', {
      area: 'chat',
      clip: timeline,
      selector: '[data-testid=chat-timeline]',
      description: 'Chat timeline — a seeded user message and its mock reply',
    });

    const composer = chat.getByTestId('chat-composer');
    await shot(page, 'composer', {
      area: 'chat',
      clip: composer,
      selector: '[data-testid=chat-composer]',
      description: 'Empty chat composer — Squisq editor + Send button',
    });

    await shot(page, 'user-bubble', {
      area: 'chat',
      clip: chat.locator('.msg-user').first(),
      selector: '.msg-user',
      description: 'A user message bubble',
    });

    await shot(page, 'assistant-bubble', {
      area: 'chat',
      clip: assistant,
      selector: '.msg-assistant',
      description: 'An assistant (mock) reply bubble',
    });

    // Type without sending — no server mutation, so this stays deterministic
    // regardless of spec execution order within the worker.
    const editor = composer.locator('.squisq-wysiwyg-editor').first();
    await editor.click();
    await page.keyboard.type('Draft a launch plan for the landing page');
    await settle(page);
    await shot(page, 'composer-typed', {
      area: 'chat',
      clip: composer,
      selector: '[data-testid=chat-composer]',
      description: 'Composer with a typed (unsent) message',
    });
  });
});
