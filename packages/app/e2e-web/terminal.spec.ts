/**
 * Monaco terminal composer — the rich-autocomplete surface that replaced the
 * plain textarea. Covers behavior parity (submit / Shift+Enter), and the four
 * completion sources: commands/scripts, craftbooks, project-wide MCP tools
 * (list + run), and workspace file paths. Drives the real built UI in
 * Chromium, so monaco + the completion provider run for real.
 *
 * The terminal is a gated developer surface — it exists only on a coding-typed
 * project with "Show advanced features" on (see `showComposeModeTabs` in
 * ProjectChat). The shared fixture world is neither, so this spec opens the
 * gate around its own tests and closes it again, leaving the world as the other
 * specs (and the screenshot gallery) expect to find it.
 */
import { GezelClient } from '@bendyline/gezel-client';
import { expect, test } from './fixtures/test.js';
import { settle } from './helpers/determinism.js';
import { gotoHome, openProject } from './helpers/nav.js';
import { shot } from './helpers/shot.js';

/** A coding taxonomy id, so `isCodingProject` admits the fixture project. */
const TERMINAL_PROJECT_TYPE_ID = 'web-app';

test.beforeEach(async ({ world, daemon }) => {
  const client = new GezelClient({ baseUrl: daemon.baseURL, token: daemon.token });
  await client.updateConfig({ showAdvancedFeatures: true });
  await client.updateProject(world!.projectId, { projectTypeId: TERMINAL_PROJECT_TYPE_ID });
});

test.afterEach(async ({ world, daemon }) => {
  const client = new GezelClient({ baseUrl: daemon.baseURL, token: daemon.token });
  // `null` clears the override rather than pinning a non-coding type, so the
  // project goes back to being unclassified the way the seed left it.
  await client.updateProject(world!.projectId, { projectTypeId: null }).catch(() => {});
  await client.updateConfig({ showAdvancedFeatures: false }).catch(() => {});
});

/** How far the mode tabs may sit from the compose frame's right edge. Both
 *  address lines end with a small gutter, so this is a ceiling, not a target. */
const MODE_TAB_RIGHT_INSET_CEILING_PX = 24;

/** Gap kept between the top of a tab and the compose frame's own top border,
 *  so the two edges read as two lines rather than one thick one. */
const MODE_TAB_TOP_INSET_PX = 2;

/**
 * Measures the compose frame's bands relative to the frame itself, so chat and
 * terminal come back in the same coordinate space and can be compared directly.
 * Runs in the page; `selectors` names each mode's equivalent of the shared
 * bands. Rounded to 2dp because sub-pixel text metrics differ between the two
 * modes' contents and are not what this is guarding.
 */
const MEASURE_BANDS = (
  shell: HTMLElement,
  selectors: { top: string; picker: string; action: string; key: string },
): {
  shellHeight: number;
  frameBackground: string;
  frameBorder: string;
  top: Record<string, number>;
  picker: Record<string, number>;
  action: Record<string, number>;
  key: Record<string, number>;
  tabs: Record<string, number>;
} | null => {
  const frame = shell.querySelector<HTMLElement>('.project-chat-compose-main');
  if (!frame) return null;
  const frameRect = frame.getBoundingClientRect();
  const frameStyle = getComputedStyle(frame);
  const round = (value: number) => Math.round(value * 100) / 100;
  const band = (selector: string) => {
    const element = shell.querySelector<HTMLElement>(selector);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {
      top: round(rect.top - frameRect.top),
      bottom: round(rect.bottom - frameRect.top),
      height: round(rect.height),
      left: round(rect.left - frameRect.left),
      rightInset: round(frameRect.right - rect.right),
    };
  };
  const top = band(selectors.top);
  const picker = band(selectors.picker);
  const action = band(selectors.action);
  const key = band(selectors.key);
  const tabs = band('.compose-mode-tabs');
  if (!top || !picker || !action || !key || !tabs) return null;
  return {
    shellHeight: round(shell.getBoundingClientRect().height),
    frameBackground: frameStyle.backgroundColor,
    frameBorder: `${frameStyle.borderWidth} ${frameStyle.borderColor}`,
    top,
    picker,
    action,
    key,
    // Sub-pixel label widths differ between the two modes, so the strip's
    // `left` is not comparable; its right edge, which is what anchors it, is.
    tabs: {
      top: tabs.top,
      bottom: tabs.bottom,
      height: tabs.height,
      rightInset: tabs.rightInset,
    },
  };
};

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
  const frame = shell.locator('.project-chat-compose-main');
  const toolbar = page.getByRole('toolbar', { name: /toolbar/i });
  await expect(toolbar).toBeVisible();
  await expect(page.getByTestId('chat-send')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Bold/ })).toBeHidden();
  const insert = page.getByRole('button', { name: 'Insert', exact: true });
  await expect(insert).toBeVisible();

  await insert.click();
  const insertMenu = page.getByRole('menu');
  await expect(insertMenu).toBeVisible();
  const [insertBox, menuBox] = await Promise.all([insert.boundingBox(), insertMenu.boundingBox()]);
  expect(insertBox).not.toBeNull();
  expect(menuBox).not.toBeNull();
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(insertBox!.y - 3);
  expect(menuBox!.y).toBeGreaterThanOrEqual(8);
  await page.keyboard.press('Escape');
  await expect(insertMenu).toBeHidden();

  const frameTreatment = await frame.evaluate((element) => {
    const style = getComputedStyle(element);
    const frameRect = element.getBoundingClientRect();
    const shellStyle = getComputedStyle(element.parentElement!);
    const toolbarHeader = element.querySelector<HTMLElement>('.squisq-editor-header');
    const editor = element.querySelector<HTMLElement>('.squisq-wysiwyg-editor');
    const toolbar = element.querySelector<HTMLElement>('.squisq-toolbar');
    const composeHeaderProbe = document.createElement('span');
    composeHeaderProbe.style.background = 'var(--chat-compose-header-bg)';
    element.append(composeHeaderProbe);
    const toolbarRect = toolbarHeader?.getBoundingClientRect();
    // Measured from the frame's CONTENT box, not its border box: the frame
    // carries the shared left inset that both compose modes lay their bands
    // against, so the border alone is no longer the reference edge.
    const borderLeftWidth =
      Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.paddingLeft);
    const borderRightWidth =
      Number.parseFloat(style.borderRightWidth) + Number.parseFloat(style.paddingRight);
    const result = {
      borderWidth: style.borderRightWidth,
      borderColor: style.borderRightColor,
      shellPaddingBottom: shellStyle.paddingBottom,
      frameRight: frameRect.right,
      toolbarInsetLeft: (toolbarRect?.left ?? Number.NaN) - (frameRect.left + borderLeftWidth),
      toolbarInsetRight: frameRect.right - borderRightWidth - (toolbarRect?.right ?? Number.NaN),
      frameBackground: style.backgroundColor,
      editorBackground: editor ? getComputedStyle(editor).backgroundColor : '',
      toolbarBackground: toolbar ? getComputedStyle(toolbar).backgroundColor : '',
      composeHeaderBackground: getComputedStyle(composeHeaderProbe).backgroundColor,
    };
    composeHeaderProbe.remove();
    return result;
  });
  expect(frameTreatment.borderWidth).toBe('1px');
  expect(frameTreatment.borderColor).not.toBe('rgba(127, 127, 127, 0.25)');
  expect(frameTreatment.shellPaddingBottom).toBe('4px');
  expect(frameTreatment.toolbarInsetLeft).toBeCloseTo(1, 0);
  expect(frameTreatment.toolbarInsetRight).toBeCloseTo(1, 0);
  expect(frameTreatment.frameBackground).toBe(frameTreatment.composeHeaderBackground);
  expect(frameTreatment.toolbarBackground).toBe(frameTreatment.composeHeaderBackground);
  expect(frameTreatment.editorBackground).not.toBe(frameTreatment.composeHeaderBackground);

  // The two compose modes are one surface with its middle swapped, so their
  // chrome is measured against each other rather than against fixed numbers.
  // Both stack the same four bands inside the same frame — a top line (chat's
  // recipients, terminal's tool rail) that hosts the mode tabs, a picker row
  // (thread / folder), an action row carrying the one primary key (Send /
  // Fire), and the typing area — and every one of those has to land on the
  // same pixel, or flipping modes visibly reflows the composer under the
  // cursor that flipped it. The action row is the one that drifted: chat's is
  // squisq's toolbar, which sizes to its content, so it tracked the height of
  // whatever key we last put in it while terminal's is a fixed band.
  const chatBands = await shell.evaluate(MEASURE_BANDS, {
    top: '.chat-composer-to',
    picker: '.gezel-chat-session-header',
    // The band, not the bar inside it: squisq's header is the toolbar plus the
    // 1px seam under it, which is what the terminal's Fire row has to match.
    action: '.squisq-editor-header',
    key: '.chat-send-btn',
  });
  await switchToTerminal(page);
  const terminalBands = await shell.evaluate(MEASURE_BANDS, {
    top: '.terminal-composer-toolbar',
    picker: '.folder-tree-switcher',
    action: '.terminal-composer-fire-row',
    key: '.terminal-fire-btn',
  });

  expect(chatBands).not.toBeNull();
  expect(terminalBands).not.toBeNull();
  expect(terminalBands!.shellHeight).toBeCloseTo(chatBands!.shellHeight, 0);
  expect(terminalBands!.frameBackground).toBe(chatBands!.frameBackground);
  expect(terminalBands!.frameBorder).toBe(chatBands!.frameBorder);
  for (const band of ['top', 'picker', 'action', 'key', 'tabs'] as const) {
    expect
      .soft(terminalBands![band], `${band} band should be identical across compose modes`)
      .toEqual(chatBands![band]);
  }

  // The tabs ARE the top line, not a control parked inside it: they fill the
  // band bar the couple of pixels that keep them off the frame's own border,
  // and they overhang its 1px rule, which is the seam the selected tab erases
  // to join the panel below.
  for (const bands of [chatBands!, terminalBands!]) {
    expect(bands.tabs.top).toBeCloseTo(bands.top.top + MODE_TAB_TOP_INSET_PX, 0);
    expect(bands.tabs.bottom).toBeCloseTo(bands.top.bottom, 0);
    expect(bands.top.bottom).toBeCloseTo(bands.picker.top, 0);
  }
  expect(chatBands!.tabs.rightInset).toBeLessThanOrEqual(MODE_TAB_RIGHT_INSET_CEILING_PX);
  expect(chatBands!.tabs.rightInset).toBeGreaterThanOrEqual(0);

  // A selected thread with no matching item — archived, or belonging to another
  // project — leaves Radix rendering an empty trigger (it shows no placeholder
  // for a value that is set). With no text there is no line box, and the
  // control used to lose 3.3px and take the picker band down with it: a whole
  // band of the frame changing height on a state nothing on screen explains,
  // which is what made chat sit shorter than terminal. Simulated by blanking
  // the value, because the state is a disagreement between two server-side
  // lists rather than something the UI can be clicked into.
  await page.getByRole('tab', { name: 'AI chat' }).click();
  const picker = shell.locator('.gezel-chat-session-header');
  await expect(picker).toBeVisible();
  const pickerHeight = () =>
    picker.evaluate((el) => Math.round(el.getBoundingClientRect().height * 100) / 100);
  const filled = await pickerHeight();
  await shell
    .locator('.gezel-chat-session-select span')
    .first()
    .evaluate((el) => {
      el.textContent = '';
    });
  expect(await pickerHeight()).toBe(filled);
});

test('aligns the output and reference split grips', async ({ page, world }) => {
  // The reference rail renders only when the conversation has side context,
  // and becomes a compact tab surface when the output pane leaves it less
  // than 840 px. Open a seeded task and give this split-geometry check a wide
  // canvas so both resize grips are expected to render.
  await page.setViewportSize({ width: 2400, height: 900 });
  await gotoProject(page, world!.projectId);

  await page
    .getByRole('button', {
      name: `Task ${world!.taskRefs[0]}: Wire up the landing page`,
    })
    .click();

  const showOutput = page.getByRole('button', { name: 'Show output pane' });
  if (await showOutput.isVisible()) await showOutput.click();

  const outputGrip = page.getByRole('separator', { name: 'Resize output pane' });
  const referenceGrip = page.getByRole('separator', { name: 'Resize reference panel' });
  await expect(outputGrip).toBeVisible();
  await expect(referenceGrip).toBeVisible();

  const [outputCenter, referenceCenter] = await Promise.all(
    [outputGrip, referenceGrip].map((grip) =>
      grip.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const paintedTop = Number.parseFloat(getComputedStyle(element, '::before').top);
        return rect.top + paintedTop;
      }),
    ),
  );

  expect(referenceCenter).toBeCloseTo(outputCenter, 0);
});

test('themes the backing behind output preview scrollbar trays', async ({ page, world }) => {
  await gotoProject(page, world!.projectId);

  const colors = await page.evaluate(() => {
    const root = document.documentElement;
    const previousTheme = root.getAttribute('data-theme');
    const frame = document.createElement('iframe');
    frame.className = 'project-output-iframe';
    const tokenProbe = document.createElement('span');
    tokenProbe.style.background = 'var(--preview-frame-bg)';
    document.body.append(frame, tokenProbe);

    root.setAttribute('data-theme', 'light');
    const light = getComputedStyle(frame).backgroundColor;
    root.setAttribute('data-theme', 'dark');
    const dark = getComputedStyle(frame).backgroundColor;
    const darkToken = getComputedStyle(tokenProbe).backgroundColor;

    frame.remove();
    tokenProbe.remove();
    if (previousTheme) root.setAttribute('data-theme', previousTheme);
    else root.removeAttribute('data-theme');
    return { light, dark, darkToken };
  });

  expect(colors.light).toBe('rgb(255, 255, 255)');
  expect(colors.dark).toBe(colors.darkToken);
  expect(colors.dark).not.toBe(colors.light);
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

test('keeps keyboard focus while switching between terminal and blank chat', async ({
  page,
  world,
}) => {
  const terminalEditor = await openTerminal(page, world!.projectId);
  await expect(terminalEditor.locator('textarea.inputarea')).toBeFocused();
  await page.keyboard.type('@');

  await expect(page.getByRole('tab', { name: 'AI chat' })).toHaveAttribute('aria-selected', 'true');
  const chatComposer = page.getByTestId('chat-composer');
  const chatEditor = chatComposer.locator('.squisq-wysiwyg-editor').first();
  await expect(chatEditor).toBeVisible();
  await expect(chatEditor).toHaveText('');
  await expect(chatEditor).toBeFocused();

  await page.keyboard.type('keep typing');
  await expect(chatEditor).toHaveText('keep typing');

  await chatEditor.fill('');
  await page.keyboard.type('> ');
  await expect(page.getByRole('tab', { name: 'Terminal' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(terminalEditor.locator('textarea.inputarea')).toBeFocused();
  await page.keyboard.type('echo focus-followed');
  await expect(terminalEditor.locator('.view-lines')).toHaveText('echo focus-followed');
});

test('lets ordinary-height output flow while preserving a horizontal scrollbar', async ({
  page,
  world,
}) => {
  await openTerminal(page, world!.projectId);
  // Keep the synthetic directory listing comfortably wider than the desktop
  // chat bubble. The previous 136-character separator landed at exactly the
  // viewport width under one font metric, so there was no overflow for the
  // scrollbar assertion to exercise.
  const nameColumnWidth = 160;
  const timeColumnWidth = 60;
  const formatFixtureRow = (name: string, lastWriteTime: string, length: string) =>
    `${name.padEnd(nameColumnWidth)}${lastWriteTime.padEnd(timeColumnWidth)}${length}`;
  const fixtureRows = Array.from({ length: 30 }, (_, index) =>
    formatFixtureRow(
      `terminal-output-fixture-${String(index + 1).padStart(2, '0')}`,
      '7/29/2026  3:47 PM',
      String(30357 + index),
    ),
  );
  const fixtureOutput = [
    formatFixtureRow('Name', 'LastWriteTime', 'Length'),
    `${'-'.repeat(nameColumnWidth - 2)}  ${'-'.repeat(timeColumnWidth - 2)}  ${'-'.repeat(12)}`,
    ...fixtureRows,
  ].join('\n');
  await page.getByTestId('chat-timeline').evaluate((timeline, text) => {
    const bubble = document.createElement('div');
    bubble.className = 'msg msg-assistant terminal-group terminal-group-output';

    const header = document.createElement('div');
    header.className = 'msg-header terminal-group-header';
    const folder = document.createElement('span');
    folder.className = 'terminal-folder-pill';
    folder.textContent = '/docs';
    const author = document.createElement('span');
    author.className = 'msg-author';
    author.textContent = 'Terminal output';
    const exit = document.createElement('span');
    exit.className = 'terminal-exit-pill terminal-exit-ok';
    exit.textContent = 'exit 0';
    const duration = document.createElement('span');
    duration.className = 'terminal-duration';
    duration.textContent = '23ms';
    header.append(folder, author, exit, duration);

    const viewport = document.createElement('section');
    viewport.className = 'terminal-output-viewport';
    viewport.setAttribute('aria-label', 'Terminal output');
    viewport.tabIndex = 0;
    const body = document.createElement('pre');
    body.className = 'terminal-output-body';
    body.textContent = text;
    viewport.append(body);
    bubble.append(header, viewport);
    timeline.append(bubble);
  }, fixtureOutput);

  const output = page
    .getByRole('region', { name: 'Terminal output' })
    .filter({ hasText: 'terminal-output-fixture' })
    .last();
  await expect(output).toBeVisible();

  const layout = await output.evaluate((viewport) => {
    const body = viewport.querySelector<HTMLElement>('.terminal-output-body');
    if (!body) return null;
    return {
      whiteSpace: getComputedStyle(body).whiteSpace,
      overflowX: getComputedStyle(viewport).overflowX,
      overflowY: getComputedStyle(viewport).overflowY,
      scrollWidth: viewport.scrollWidth,
      clientWidth: viewport.clientWidth,
      scrollHeight: viewport.scrollHeight,
      clientHeight: viewport.clientHeight,
      tabIndex: viewport.tabIndex,
    };
  });
  expect(layout).not.toBeNull();
  expect(layout!.whiteSpace).toBe('pre');
  expect(layout!.overflowX).toBe('auto');
  expect(layout!.overflowY).toBe('auto');
  expect(layout!.scrollWidth).toBeGreaterThan(layout!.clientWidth);
  expect(layout!.scrollHeight).toBeLessThanOrEqual(layout!.clientHeight + 1);
  expect(layout!.tabIndex).toBe(0);

  const bubble = page
    .locator('.terminal-group-output')
    .filter({ hasText: 'terminal-output-fixture' })
    .last();
  await shot(page, 'wide-output', {
    area: 'terminal',
    description:
      'Ordinary-height terminal output flows in history while wide columns scroll horizontally',
    clip: bubble,
    selector: '.terminal-group-output',
  });
});

test('places the caret after a craftbook staged from the Terminal Tasks gallery', async ({
  page,
  world,
  daemon,
}) => {
  await gotoProject(page, world!.projectId);

  const craftbook = await page.evaluate(
    async ([projectId, token]) => {
      const response = await fetch(`/api/projects/${projectId}/craftbooks`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) return null;
      const body = await response.json();
      const missing = body.missingToolsets ?? {};
      const item = body.items?.find((candidate: { manifest?: Record<string, unknown> }) => {
        const manifest = candidate.manifest;
        if (!manifest || typeof manifest.id !== 'string' || typeof manifest.name !== 'string') {
          return false;
        }
        const properties = (manifest.paramSchema as { properties?: Record<string, unknown> })
          ?.properties;
        return !missing[manifest.id] && (!properties || Object.keys(properties).length === 0);
      });
      if (!item) return null;
      return {
        id: item.manifest.id as string,
        name: item.manifest.name as string,
        command:
          typeof item.manifest.command === 'string' && item.manifest.command.trim()
            ? item.manifest.command.trim()
            : (item.manifest.id as string),
      };
    },
    [world!.projectId, daemon.token] as const,
  );
  test.skip(!craftbook, 'no parameterless craftbook available to stage');

  await switchToTerminal(page);
  await page
    .getByRole('button', {
      name: 'Craftbooks and workspace skills a gezel can run for you',
    })
    .click();
  await page.getByRole('textbox', { name: 'Filter commands' }).fill(craftbook!.id);
  await page.locator('.commands-panel-item').filter({ hasText: craftbook!.name }).first().click();

  const editor = page.getByTestId('terminal-editor');
  await expect(editor.locator('.monaco-editor')).toBeVisible({ timeout: 15_000 });
  await expect(editor.locator('.view-lines')).toHaveText(craftbook!.command);

  await page.keyboard.type(' --review');
  await expect(editor.locator('.view-lines')).toHaveText(`${craftbook!.command} --review`);
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
