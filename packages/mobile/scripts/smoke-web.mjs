import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// Test the production bundle and its real portable filesystem/API transport.
// Native inference is intentionally unavailable in an ordinary browser; Android
// instrumentation exercises provider generation with the native test fixture.
const { chromium } = createRequire(new URL('../../ui/package.json', import.meta.url))('playwright');
const url = process.argv[2] ?? 'http://127.0.0.1:4178';
const screenshots = process.argv[3];
const browser = await chromium.launch({ headless: true });
let page;
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
  });
  await context.addInitScript(() => {
    // The client captures fetch during module initialization. Observe host API
    // results before that happens, including errors swallowed by optional UI.
    // Never record the bearer token, request headers or document contents.
    window.__gezelSmokeCalls = [];
    let bridge;
    Object.defineProperty(window, '__GEZEL__', {
      configurable: true,
      get: () => bridge,
      set: (value) => {
        bridge = value;
        if (!value?.fetch) return;
        const fetch = value.fetch;
        value.fetch = async (...args) => {
          const input = args[0];
          const path = new URL(typeof input === 'string' ? input : input.url, location.origin)
            .pathname;
          const method = args[1]?.method ?? input?.method ?? 'GET';
          try {
            const response = await fetch(...args);
            window.__gezelSmokeCalls.push({ path, method, status: response.status });
            return response;
          } catch (error) {
            window.__gezelSmokeCalls.push({ path, method, error: String(error) });
            throw error;
          }
        };
      },
    });
  });
  page = await context.newPage();
  const errors = [];
  const failedCalls = [];
  const externalRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(url).origin) {
      externalRequests.push(request.url());
    }
  });
  async function checkpoint(name) {
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
      false,
      `${name} overflows horizontally`,
    );
    failedCalls.push(
      ...(await page.evaluate(() =>
        window.__gezelSmokeCalls.filter((call) => call.error || call.status >= 500),
      )),
    );
    assert.deepEqual(failedCalls, [], `${name} called an unavailable host API`);
    assert.deepEqual(errors, [], `${name} has an uncaught browser error`);
    const unnamed = [];
    for (const role of [
      'button',
      'combobox',
      'textbox',
      'searchbox',
      'spinbutton',
      'checkbox',
      'radio',
      'tab',
      'link',
    ]) {
      for (const control of await page.getByRole(role, { name: /^\s*$/ }).all()) {
        if (await control.isVisible())
          unnamed.push({
            role,
            html: (await control.evaluate((element) => element.outerHTML)).slice(0, 400),
          });
      }
    }
    assert.deepEqual(unnamed, [], `${name} has visible controls without accessible names`);
    for (const control of await page
      .locator('.app-compact')
      .locator(
        '.task-detail-actions button, .task-step-panel .gz-select-trigger, .gezel-chat-project-select, .gezel-chat-session-select',
      )
      .all()) {
      if (!(await control.isVisible())) continue;
      const target = await control.boundingBox();
      assert(
        target && target.width >= 44 && target.height >= 44,
        `${name} compact control must be at least 44px in each dimension: ${await control.evaluate((element) => element.outerHTML.slice(0, 400))}`,
      );
    }
    for (const modal of await page
      .locator('[role="dialog"]:visible, [role="alertdialog"]:visible')
      .all()) {
      const bounds = await modal.boundingBox();
      const viewport = page.viewportSize();
      assert(
        bounds &&
          bounds.x >= 0 &&
          bounds.y >= 0 &&
          bounds.x + bounds.width <= viewport.width + 1 &&
          bounds.y + bounds.height <= viewport.height + 1,
        `${name} dialog must fit within the viewport`,
      );
      assert.equal(
        await modal.evaluate((element) => element.scrollWidth > element.clientWidth + 1),
        false,
        `${name} dialog overflows horizontally`,
      );
      for (const button of await modal.locator('.gz-dialog-actions button').all()) {
        const action = await button.boundingBox();
        assert(
          action &&
            action.x >= 0 &&
            action.y >= 0 &&
            action.x + action.width <= viewport.width + 1 &&
            action.y + action.height <= viewport.height + 1,
          `${name} dialog action must stay visible`,
        );
      }
    }
    if (screenshots) {
      await mkdir(screenshots, { recursive: true });
      await page.screenshot({ path: resolve(screenshots, `${name}.png`) });
    }
    console.log(`Passed ${name}`);
  }
  async function navigation() {
    await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    const nav = page.getByRole('navigation', { name: 'Primary navigation', exact: true });
    const open = page.getByRole('button', { name: 'Navigation', exact: true });
    // The rail is either already open or sits behind the header button, and
    // which one shows depends on where the app last was. Wait for whichever
    // arrives rather than sampling once: immediately after a load neither is
    // mounted, and committing to one path waits out the whole timeout on a
    // page that was always going to show the other.
    await nav.or(open).first().waitFor();
    if (await open.isVisible()) await open.click();
    await nav.waitFor();
    return nav;
  }
  async function openProject() {
    const nav = await navigation();
    await nav.getByRole('button', { name: 'Offline field notes', exact: true }).click();
    await page.getByRole('tablist', { name: 'Project sections', exact: true }).waitFor();
  }
  async function globalSearch() {
    const input = page.getByRole('textbox', { name: 'Search', exact: true });
    if (await input.isVisible()) return input;
    // Compact layout collapses global search behind a header button carrying
    // the same accessible name; it becomes the input once activated.
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await input.waitFor();
    return input;
  }
  async function createFile(name, text) {
    await page.getByRole('button', { name: 'New file', exact: true }).click();
    await page.getByRole('textbox', { name: 'Path', exact: true }).fill(name);
    await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.locator('[contenteditable="true"]').fill(text);
    await page.getByText('Saved', { exact: true }).waitFor();
  }

  await page.goto(url);
  const nav = await navigation();
  for (const name of ['Projects', 'Documents', 'Gezellen', 'Tasks', 'Settings']) {
    assert.equal(await nav.getByRole('button', { name, exact: true }).isEnabled(), true);
  }
  for (const name of ['Knowledge', 'History']) {
    assert.equal(await nav.getByRole('button', { name, exact: true }).count(), 0);
  }
  await checkpoint('phone-navigation');

  const projectTrigger = nav.getByRole('button', { name: 'New project', exact: true });
  await projectTrigger.focus();
  await page.keyboard.press('Enter');
  const projectDialog = page.getByRole('dialog');
  await projectDialog.waitFor();
  for (let index = 0; index < 25; index++) {
    await page.keyboard.press(index % 3 === 0 ? 'Shift+Tab' : 'Tab');
    assert(
      await projectDialog.evaluate((element) => element.contains(document.activeElement)),
      'Project dialog must keep keyboard focus inside',
    );
  }
  await page.keyboard.press('Escape');
  await projectDialog.waitFor({ state: 'hidden' });
  const restoredFocus = await page.evaluate(() => ({
    tag: document.activeElement?.tagName,
    visible:
      document.activeElement instanceof HTMLElement &&
      document.activeElement.getClientRects().length > 0,
    label:
      document.activeElement?.getAttribute('aria-label') ??
      document.activeElement?.textContent?.slice(0, 80),
  }));
  assert(
    restoredFocus.visible && restoredFocus.tag !== 'BODY',
    `Closing the project dialog must restore focus to the visible destination: ${JSON.stringify(restoredFocus)}`,
  );
  await checkpoint('phone-dialog-keyboard');

  await navigation();
  await nav.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('radio', { name: 'General', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Offline field notes');
  await page
    .getByRole('textbox', { name: 'About', exact: true })
    .fill('A field journal stored on this device.');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.getByRole('tab', { name: 'Workspace', exact: true }).click();
  await createFile('brief.md', 'A quiet morning by the river.');
  await checkpoint('phone-workspace');

  await page.getByRole('tab', { name: 'Artifacts', exact: true }).click();
  await createFile('report.md', 'Field report: three herons beside the river.');
  await checkpoint('phone-artifact');

  await (await navigation()).getByRole('button', { name: 'New document', exact: true }).click();
  await page.getByRole('textbox', { name: 'Path', exact: true }).fill('field-guide');
  await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.locator('[contenteditable="true"]').fill('Keep careful notes about local wildlife.');
  await page.getByText('Saved', { exact: true }).waitFor();
  await checkpoint('phone-document');

  await (await navigation()).getByRole('button', { name: 'New gezel', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Name Pick a random name', exact: true })
    .fill('Ada Field Guide');
  await page.getByRole('textbox', { name: 'Role', exact: true }).fill('Nature observer');
  await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.getByRole('heading', { name: 'Ada Field Guide', exact: true }).waitFor();
  await checkpoint('phone-gezel');

  await openProject();
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Add Gezel', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Ada Field Guide/ })
    .click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page
    .getByRole('region', { name: 'Assigned gezellen', exact: true })
    .getByText('Ada Field Guide', { exact: true })
    .waitFor();
  await checkpoint('phone-project-settings');
  await page.getByRole('tab', { name: 'Chat', exact: true }).first().click();
  await page.getByRole('button', { name: 'Choose recipients', exact: true }).click();
  await page.getByRole('button', { name: 'Talk to Ada Field Guide', exact: true }).click();
  await page
    .locator('[contenteditable="true"]')
    .fill('Review [my brief](workspace/brief.md) using [the guide](documents/field-guide.md).');
  await page.waitForFunction(() =>
    window.__gezelSmokeCalls.some(
      (call) =>
        call.path.endsWith('/prompt-drafts') && call.method === 'POST' && call.status === 200,
    ),
  );
  await checkpoint('phone-project-chat');

  await page.reload();
  await openProject();
  await page.getByRole('tab', { name: 'Chat', exact: true }).first().click();
  await page.locator('[contenteditable="true"]').getByText('Review', { exact: false }).waitFor();
  await page.getByRole('tab', { name: 'Workspace', exact: true }).click();
  await page.getByText('brief.md', { exact: true }).click();
  await page
    .locator('[contenteditable="true"]')
    .getByText('A quiet morning by the river.', { exact: true })
    .waitFor();
  await page.getByRole('tab', { name: 'Artifacts', exact: true }).click();
  await page.getByText('report.md', { exact: true }).click();
  await page
    .locator('[contenteditable="true"]')
    .getByText('Field report: three herons beside the river.', { exact: true })
    .waitFor();
  await (await navigation()).getByRole('button', { name: 'Documents', exact: true }).click();
  await page.getByTestId('documents-view').getByText('field-guide.md', { exact: true }).click();
  await page
    .locator('[contenteditable="true"]')
    .getByText('Keep careful notes about local wildlife.', { exact: true })
    .waitFor();
  await checkpoint('phone-persisted-document');

  const backToFiles = page.getByRole('button', { name: 'Back to files', exact: true });
  if (await backToFiles.isVisible()) await backToFiles.click();
  await page
    .getByRole('searchbox', { name: 'Search document contents', exact: true })
    .fill('wildlife');
  await page
    .locator('.documents-search-snippet')
    .getByText('Keep careful notes about local wildlife.', { exact: false })
    .waitFor();
  await checkpoint('phone-document-search');
  await (await globalSearch()).fill('herons');
  await page
    .getByTestId('search-palette')
    .getByRole('option')
    .filter({ hasText: 'report.md' })
    .waitFor();
  await checkpoint('phone-global-search');
  await (await globalSearch()).fill('');
  await (await globalSearch()).press('Escape');

  await openProject();
  await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: '+ New task', exact: true }).click();
  await page.getByRole('radio', { name: 'General task', exact: true }).click();
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Review the field notes');
  await page
    .getByRole('textbox', { name: /Description/ })
    .fill('Read the brief and prepare a short report.');
  await page.getByRole('button', { name: 'Create task', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.getByRole('heading', { name: 'Review the field notes', exact: true }).waitFor();
  await page.getByRole('button', { name: /^Fire (task|anyway)$/ }).waitFor();
  await page
    .locator('.task-notes-composer [contenteditable="true"]')
    .fill('Use the saved field guide.');
  await page.getByRole('button', { name: 'Post note', exact: true }).click();
  await page
    .locator('.task-notes-feed')
    .getByText('Use the saved field guide.', { exact: true })
    .waitFor();
  await page
    .getByRole('heading', { name: 'Review the field notes', exact: true })
    .scrollIntoViewIfNeeded();
  const taskDetail = await page.locator('.task-detail').boundingBox();
  assert(
    taskDetail &&
      taskDetail.width >= 300 &&
      taskDetail.x >= 0 &&
      taskDetail.x + taskDetail.width <= 391,
    'Phone task details need a full-width readable panel',
  );
  await checkpoint('phone-task-detail');
  await page.getByRole('button', { name: 'Back to tasks', exact: true }).click();
  await page.getByRole('button', { name: /Review the field notes/ }).click();
  await page.getByRole('heading', { name: 'Review the field notes', exact: true }).waitFor();

  await (await navigation()).getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  const settingsPanel = await page.locator('.settings-panel').boundingBox();
  const navigationButton = await page
    .getByRole('button', { name: 'Navigation', exact: true })
    .boundingBox();
  const modelPicker = await page.getByRole('combobox', { name: 'Use a model' }).boundingBox();
  assert(
    settingsPanel && settingsPanel.width >= 300,
    'Phone Settings needs a readable full-width panel',
  );
  assert(
    navigationButton &&
      navigationButton.height >= 44 &&
      navigationButton.y >= 0 &&
      navigationButton.y + navigationButton.height <= 844,
    'Settings must keep the Navigation control fully visible and tappable',
  );
  assert(
    modelPicker && modelPicker.x >= 0 && modelPicker.x + modelPicker.width <= 391,
    'Phone model picker must remain inside the viewport',
  );
  await checkpoint('phone-model-settings');
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Show advanced features', exact: true }).click();
  await page.locator('input[type="checkbox"]:checked:not(:disabled)').waitFor();
  await (await navigation()).getByRole('button', { name: 'Scripts', exact: true }).click();
  await page.getByRole('heading', { name: 'Scripts', exact: true }).waitFor();
  await checkpoint('phone-scripts');
  await (await navigation()).getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Backup and restore', exact: true }).click();
  await page.getByRole('button', { name: 'Back up content…', exact: true }).click();
  const backupDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Choose where to save…', exact: true }).click();
  const download = await backupDownload;
  const archive = await readFile(await download.path());
  assert.equal(
    archive.subarray(0, 4).toString('hex'),
    '504b0304',
    'Export must contain real ZIP bytes',
  );
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await openProject();
  await page.getByRole('tab', { name: 'Workspace', exact: true }).click();
  await page.getByText('brief.md', { exact: true }).click();
  await page.locator('[contenteditable="true"]').fill('A newer draft after the backup.');
  await page.getByText('Saved', { exact: true }).waitFor();
  await (await navigation()).getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Backup and restore', exact: true }).click();
  await page.getByRole('button', { name: 'Restore from a backup…', exact: true }).click();
  await page.getByLabel('Backup file', { exact: true }).setInputFiles({
    name: download.suggestedFilename(),
    mimeType: 'application/zip',
    buffer: archive,
  });
  await page.getByText(/item\(s\) already exist here/).waitFor();
  const restoreButton = page.getByRole('button', { name: /^Restore \d+ item\(s\)$/ });
  assert.equal(
    await restoreButton.isDisabled(),
    true,
    'Conflicting content requires explicit replacement selection',
  );
  for (const checkbox of await page
    .getByRole('checkbox', { name: 'replace the one already here', exact: true })
    .all())
    await checkbox.check();
  await checkpoint('phone-backup-review');
  await Promise.all([page.waitForEvent('load'), restoreButton.click()]);
  await openProject();
  await page.getByRole('tab', { name: 'Workspace', exact: true }).click();
  await page.getByText('brief.md', { exact: true }).click();
  await page
    .locator('[contenteditable="true"]')
    .getByText('A quiet morning by the river.', { exact: true })
    .waitFor();
  await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: /Review the field notes/ }).click();
  await page.getByRole('heading', { name: 'Review the field notes', exact: true }).waitFor();
  await page
    .locator('.task-notes-feed')
    .getByText('Use the saved field guide.', { exact: true })
    .waitFor();
  await checkpoint('phone-restored-project');
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).waitFor();
  await openProject();
  await page.getByRole('tab', { name: 'Chat', exact: true }).first().click();
  await page.locator('[contenteditable="true"]').getByText('Review', { exact: false }).waitFor();
  await checkpoint('tablet-project');
  const previewUrl = new URL(url);
  previewUrl.searchParams.set('layout', 'mobile');
  await page.goto(previewUrl.href);
  await (await navigation()).getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Backup and restore', exact: true }).click();
  await page.getByRole('button', { name: 'Back up content…', exact: true }).click();
  await page.locator('.gz-backup-dialog .storage-list li').first().waitFor();
  const frame = await page.locator('.app-mobile-preview').boundingBox();
  const previewDialog = await page.getByRole('alertdialog').boundingBox();
  assert(
    frame &&
      previewDialog &&
      previewDialog.x >= frame.x &&
      previewDialog.x + previewDialog.width <= frame.x + frame.width + 1,
    'Desktop mobile preview dialogs must fit the same narrow app frame',
  );
  await checkpoint('desktop-mobile-preview-backup');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.goto(url);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 320, height: 640 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  await navigation();
  await checkpoint('phone-large-text-navigation');
  await openProject();
  await page.getByRole('tab', { name: 'Chat', exact: true }).first().click();
  const largeTextDraft = page.locator('.chat-composer [contenteditable="true"]');
  await largeTextDraft.focus();
  await largeTextDraft.scrollIntoViewIfNeeded();
  assert(
    await largeTextDraft.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.top >= 0 && bounds.bottom <= innerHeight;
    }),
    'The draft must remain reachable at 200% text size',
  );
  await checkpoint('phone-large-text-project');
  await (await navigation()).getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await checkpoint('phone-large-text-settings');
  assert.deepEqual(
    externalRequests,
    [],
    'Offline product workflow must not need an external service',
  );
  console.log(
    'Shared mobile UI: project, gezel, crew, workspace, artifact, document, draft persistence, lexical search, tasks, scripts, ZIP export/review/restore, phone/tablet layout and host capability checks passed.',
  );
} catch (error) {
  if (page) console.error(await page.locator('body').ariaSnapshot());
  throw error;
} finally {
  await browser.close();
}
