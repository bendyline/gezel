/**
 * Monaco terminal composer — the rich-autocomplete surface that replaced the
 * plain textarea. Covers behavior parity (submit / Shift+Enter), and the four
 * completion sources: commands/scripts, craftbooks, project-wide MCP tools
 * (list + run), and workspace file paths. Drives the real built UI in
 * Chromium, so monaco + the completion provider run for real.
 */
import { expect, test } from './fixtures/test.js';
import { settle } from './helpers/determinism.js';
import { gotoHome, openProject } from './helpers/nav.js';

async function gotoProject(page: import('@playwright/test').Page, projectId: string) {
  await gotoHome(page);
  await openProject(page, projectId);
  await expect(page.getByTestId('project-tab-chat')).toBeVisible({ timeout: 15_000 });
  await settle(page);
}

async function switchToTerminal(page: import('@playwright/test').Page) {
  await page.getByRole('tab', { name: 'Terminal' }).click();
  const editor = page.getByTestId('terminal-editor');
  await expect(editor.locator('.monaco-editor')).toBeVisible({ timeout: 15_000 });
  return editor;
}

async function openTerminal(page: import('@playwright/test').Page, projectId: string) {
  await gotoProject(page, projectId);
  return switchToTerminal(page);
}

test('keeps terminal composer geometry aligned with chat', async ({ page, world }) => {
  await gotoProject(page, world!.projectId);

  const shell = page.locator('.project-chat-compose-shell');
  const chatHeight = await shell.evaluate((element) => element.getBoundingClientRect().height);
  const chatModeAlignment = await shell.evaluate((element) => {
    const tabs = element.querySelector<HTMLElement>('.project-chat-compose-toggle');
    const send = element.querySelector<HTMLElement>('[data-testid="chat-send"]');
    const input = element.querySelector<HTMLElement>('.squisq-wysiwyg-container');
    if (!tabs || !send || !input) return null;
    const tabsRect = tabs.getBoundingClientRect();
    const sendRect = send.getBoundingClientRect();
    const inputRect = input.getBoundingClientRect();
    return {
      tabsTop: tabsRect.top,
      tabsBottom: tabsRect.bottom,
      toolbarBottom: sendRect.bottom,
      inputBottom: inputRect.bottom,
    };
  });
  const sessionRow = page.locator('.gezel-chat-session-header');
  const sessionRowHeight = await sessionRow.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  const sessionRowPadding = await sessionRow.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      blockStart: Number.parseFloat(style.paddingBlockStart),
      inlineStart: Number.parseFloat(style.paddingInlineStart),
    };
  });
  expect(chatModeAlignment).not.toBeNull();
  expect(chatModeAlignment!.tabsTop).toBeGreaterThanOrEqual(chatModeAlignment!.toolbarBottom);
  expect(chatModeAlignment!.tabsBottom).toBeCloseTo(chatModeAlignment!.inputBottom, 0);

  await switchToTerminal(page);

  const terminalHeight = await shell.evaluate((element) => element.getBoundingClientRect().height);
  const terminalModeAlignment = await shell.evaluate((element) => {
    const tabs = element.querySelector<HTMLElement>('.project-chat-compose-toggle');
    const toolbar = element.querySelector<HTMLElement>('.terminal-composer-toolbar');
    const input = element.querySelector<HTMLElement>('.terminal-composer-input-wrap');
    if (!tabs || !toolbar || !input) return null;
    const tabsRect = tabs.getBoundingClientRect();
    const toolbarRect = toolbar.getBoundingClientRect();
    const inputRect = input.getBoundingClientRect();
    return {
      tabsTop: tabsRect.top,
      tabsBottom: tabsRect.bottom,
      toolbarBottom: toolbarRect.bottom,
      inputBottom: inputRect.bottom,
    };
  });
  const folderRow = page.locator('.project-chat-compose-main .folder-tree-switcher');
  const folderRowHeight = await folderRow.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  const folderRowPadding = await folderRow.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      blockStart: Number.parseFloat(style.paddingBlockStart),
      inlineStart: Number.parseFloat(style.paddingInlineStart),
    };
  });
  expect.soft(terminalHeight).toBeCloseTo(chatHeight, 0);
  expect.soft(folderRowHeight).toBeCloseTo(sessionRowHeight, 0);
  expect.soft(folderRowPadding).toEqual(sessionRowPadding);
  expect(terminalModeAlignment).not.toBeNull();
  expect(terminalModeAlignment!.tabsTop).toBeGreaterThanOrEqual(
    terminalModeAlignment!.toolbarBottom,
  );
  expect(terminalModeAlignment!.tabsBottom).toBeCloseTo(terminalModeAlignment!.inputBottom, 0);
});

test('mounts, submits on Enter, newlines on Shift+Enter', async ({ page, world }) => {
  const editor = await openTerminal(page, world!.projectId);
  await expect(page.locator('.terminal-editor-placeholder')).toBeVisible();

  await editor.click();
  await page.keyboard.type('echo hi-terminal');
  await expect(page.locator('.terminal-editor-placeholder')).toHaveCount(0);
  await page.keyboard.press('Enter');
  // Optimistic clear → placeholder returns; the command ran (output bubble).
  await expect(page.locator('.terminal-editor-placeholder')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('hi-terminal').first()).toBeVisible({ timeout: 15_000 });

  await page.keyboard.type('a');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('b');
  await expect(editor.locator('.view-line')).toHaveCount(2);
});

test('autocompletes craftbooks', async ({ page, world }) => {
  const editor = await openTerminal(page, world!.projectId);
  await page.waitForTimeout(1500); // craftbook fetch
  await editor.click();
  await page.keyboard.type('a');
  const widget = page.locator('.suggest-widget');
  await expect(widget).toBeVisible({ timeout: 8_000 });
  await expect(widget.locator('.monaco-list-row').first()).toBeVisible();
});

test('lists, completes, and runs project-wide MCP tools', async ({ page, world, daemon }) => {
  const terminalEventsReady = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname === `/api/projects/${world!.projectId}/terminals/events`,
    { timeout: 30_000 },
  );
  await gotoProject(page, world!.projectId);
  // A successful run is delivered to the timeline over this project-scoped
  // stream. Wait for the subscription itself instead of relying on a fixed
  // delay that becomes unreliable when the full suite runs four workers.
  expect((await terminalEventsReady).status()).toBe(200);
  const probe = await page.evaluate(
    async ([pid, token]) => {
      const r = await fetch(`/api/projects/${pid}/tools`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const b = r.ok ? await r.json() : null;
      return { ok: r.ok, count: b?.tools?.length ?? 0 };
    },
    [world!.projectId, daemon.token] as const,
  );
  test.skip(!probe.ok || probe.count === 0, 'project tool bridge unavailable in this env');

  const editor = await switchToTerminal(page);
  await page.waitForTimeout(4000); // bridge build + tool fetch
  await editor.click();
  await page.keyboard.type('list_mem');
  const widget = page.locator('.suggest-widget');
  const listMemoriesSuggestion = widget
    .locator('.monaco-list-row', { hasText: 'list_memories' })
    .first();
  await expect(listMemoriesSuggestion).toBeVisible({ timeout: 8_000 });

  // Accept the completion through Monaco itself. Replacing the prefix with a
  // platform select-all shortcut is racy on macOS and bypasses the behavior
  // this test is meant to cover.
  await listMemoriesSuggestion.click();
  await expect(widget).toBeHidden();
  const runResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/projects/${world!.projectId}/terminals/run`,
    { timeout: 30_000 },
  );
  await page.keyboard.press('Enter');
  const response = await runResponse;
  expect(response.request().postDataJSON()).toMatchObject({ input: 'list_memories' });
  expect(response.status()).toBe(202);
  await expect(
    page.locator('.terminal-cmd-code').filter({ hasText: /^list_memories$/ }),
  ).toBeVisible({ timeout: 15_000 });
});

test('autocompletes workspace file paths', async ({ page, world, daemon }) => {
  await gotoProject(page, world!.projectId);
  // Force a scan, then poll until the file index populates.
  const probe = await page.evaluate(
    async ([pid, token]) => {
      const h = token ? { Authorization: `Bearer ${token}` } : {};
      await fetch(`/api/projects/${pid}/index/refresh`, { method: 'POST', headers: h }).catch(
        () => {},
      );
      for (let i = 0; i < 30; i++) {
        const r = await fetch(`/api/projects/${pid}/index/files?prefix=`, { headers: h });
        if (r.ok) {
          const b = await r.json();
          if (b.paths?.length) return b.paths as string[];
        }
        await new Promise((res) => setTimeout(res, 500));
      }
      return [] as string[];
    },
    [world!.projectId, daemon.token] as const,
  );
  const target = probe.find((p) => /^[a-z]/i.test(p)) ?? probe[0];
  test.skip(!target, 'no indexed files in this fixture');

  const editor = await switchToTerminal(page);
  await page.waitForTimeout(1500);
  await editor.click();
  await page.keyboard.type(`cat ${target!.slice(0, 3)}`);
  const widget = page.locator('.suggest-widget');
  await expect(widget.locator('.monaco-list-row', { hasText: target! }).first()).toBeVisible({
    timeout: 8_000,
  });
});
