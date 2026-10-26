import { expect, test } from '@playwright/test';
import { waitForAppReady } from '../e2e/helpers/app-ready.js';

test('app readiness waits for a startup module that arrives after the live shell', async ({
  page,
}) => {
  let markRequested!: () => void;
  let release!: () => void;
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('http://startup.test/', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<html><head><script>
        const script = document.createElement('script');
        script.type = 'module';
        script.src = '/startup.js';
        script.async = false;
        document.head.append(script);
      </script></head><body>
        <div id="root"><aside data-testid="app-sidebar">Navigation</aside></div>
      </body></html>`,
    }),
  );
  await page.route('http://startup.test/startup.js', async (route) => {
    markRequested();
    await released;
    await route.fulfill({
      contentType: 'text/javascript',
      body: `document.body.insertAdjacentHTML('beforeend', '<div id="startup-home">Starting</div>');
        document.getElementById('root').setAttribute('inert', '');`,
    });
  });
  try {
    await page.goto('http://startup.test/', { waitUntil: 'domcontentloaded' });
    await requested;
    const waiting = waitForAppReady(page);
    // Hold the module after React's shell is visible, reproducing the CI order.
    expect(
      await Promise.race([
        waiting.then(() => 'ready'),
        new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 250)),
      ]),
    ).toBe('waiting');
    release();
    await expect(page.locator('#startup-home')).toBeVisible();
    await page.evaluate(() => {
      document.getElementById('startup-home')!.remove();
      document.getElementById('root')!.removeAttribute('inert');
    });
    await waiting;
  } finally {
    release();
  }
});

test('app readiness also accepts a shell without the startup bridge', async ({ page }) => {
  await page.setContent('<div id="root"><aside data-testid="app-sidebar">Navigation</aside></div>');
  await waitForAppReady(page);
});
