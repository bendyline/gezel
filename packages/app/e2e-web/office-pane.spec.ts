import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/test.js';

/**
 * The Office task pane, loaded from the fixture daemon with a stand-in for
 * Microsoft's office.js. Real Office is covered by the manual recipe in
 * docs/office-integrations.md; this proves the pane's boot, its project
 * lookup, and that it offers its document tools to the project's gezels.
 */

function officeShim(documentUrl: string): string {
  return `
    (function () {
      var paragraphs = [{ text: 'Quarterly plan', style: 'Heading 1' }, { text: 'Grow the north region.', style: 'Normal' }];
      function coll(items) { return { items: items, load: function () {} }; }
      window.Office = {
        HostType: { Word: 'Word', Excel: 'Excel', PowerPoint: 'PowerPoint' },
        CoercionType: { Text: 'text' },
        AsyncResultStatus: { Succeeded: 'succeeded', Failed: 'failed' },
        onReady: function () { return Promise.resolve({ host: 'Word' }); },
        context: {
          host: 'Word',
          document: {
            url: ${JSON.stringify(documentUrl)},
            getSelectedDataAsync: function (_t, cb) { cb({ status: 'succeeded', value: 'Grow the north region.' }); },
          },
          requirements: { isSetSupported: function () { return true; } },
        },
      };
      window.Word = {
        InsertLocation: { start: 'Start', end: 'End', replace: 'Replace' },
        run: function (fn) {
          var body = { paragraphs: coll(paragraphs), search: function () { return coll([]); } };
          return fn({ document: { body: body, getSelection: function () { return { text: '', paragraphs: coll([]), load: function () {} }; } }, sync: function () { return Promise.resolve(); } });
        },
      };
    })();
  `;
}

async function useOfficeShim(page: Page, documentUrl: string): Promise<void> {
  await page.route('https://appsforoffice.microsoft.com/**', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: officeShim(documentUrl) }),
  );
}

let docDir: string;
test.beforeEach(async () => {
  docDir = await mkdtemp(join(tmpdir(), 'gezel-office-pane-'));
  await writeFile(join(docDir, 'plan.docx'), 'placeholder');
});
test.afterEach(async () => {
  await rm(docDir, { recursive: true, force: true });
});

test('the Word pane connects, finds the project, and offers its document tools', async ({
  page,
  daemon,
}) => {
  await useOfficeShim(page, join(docDir, 'plan.docx'));
  await page.addInitScript(
    (token: string) => window.localStorage.setItem('gezel:office:token', token),
    daemon.token,
  );

  const inferred = page.waitForResponse((res) =>
    res.url().endsWith('/api/projects/infer-for-path'),
  );
  await page.goto('/office/word/taskpane.html');
  const body = (await (await inferred).json()) as { matchedBy: string; reason?: string };
  // A document in the temp directory never gets a folder project of its own.
  expect(body).toMatchObject({ matchedBy: 'default', reason: 'temp-dir' });

  await expect(page.locator('.office-pane-project-name')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Allow edits' })).toBeChecked();
  await expect(page.locator('iframe.office-pane-chat')).toHaveAttribute(
    'src',
    /embedded=chat&compact=1&projectId=/,
  );

  // The pane's relay publishes the Word tools, write tools included.
  await expect
    .poll(async () => {
      const res = await page.request.get(`${daemon.baseURL}/api/app-tools/relays`, {
        headers: { Authorization: `Bearer ${daemon.token}` },
      });
      return JSON.stringify(await res.json());
    })
    .toContain('doc_insert_text');

  // Turning edits off withdraws the write tools and keeps the reads.
  await page.getByRole('checkbox', { name: 'Allow edits' }).uncheck();
  await expect
    .poll(async () => {
      const res = await page.request.get(`${daemon.baseURL}/api/app-tools/relays`, {
        headers: { Authorization: `Bearer ${daemon.token}` },
      });
      const text = JSON.stringify(await res.json());
      return text.includes('doc_read') && !text.includes('doc_insert_text');
    })
    .toBe(true);
});

test('first run shows the connection code with a copy button', async ({ page }) => {
  await useOfficeShim(page, join(docDir, 'plan.docx'));
  await page.route('**/v1/apps/register', (route) =>
    route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        grantRequestId: 'g1',
        status: 'pending',
        verificationRequired: true,
        verificationCode: 'K7Q2ZP',
      }),
    }),
  );
  await page.route('**/v1/apps/grant/g1**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'pending' }),
    }),
  );
  await page.addInitScript(() => window.localStorage.removeItem('gezel:office:token'));
  await page.goto('/office/word/taskpane.html');
  await expect(page.getByRole('heading', { name: 'Connect this pane to Gezel' })).toBeVisible();
  await expect(page.getByLabel('Connection code')).toHaveText('K7Q2ZP');
  await expect(page.getByRole('button', { name: 'Copy' })).toBeVisible();
});

test('off the Office listener, the daemon refuses browser registration', async ({ page }) => {
  await useOfficeShim(page, join(docDir, 'plan.docx'));
  await page.addInitScript(() => window.localStorage.removeItem('gezel:office:token'));
  await page.goto('/office/word/taskpane.html');
  await expect(
    page.getByText('Gezel did not recognize this page.', { exact: false }),
  ).toBeVisible();
});
