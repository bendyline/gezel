import { expect, test } from '@playwright/test';
import { settle } from './helpers/determinism.js';

// These exercise the capture precondition without a daemon or a PNG baseline.
test('visual capture rejects a failed font instead of accepting fallback text', async ({
  page,
}) => {
  await page.setContent('<p>Font readiness</p>');
  await page.evaluate(async () => {
    const font = new FontFace('Broken visual font', new Uint8Array([0, 1, 2, 3]));
    document.fonts.add(font);
    await font.load().catch(() => {});
  });

  await expect(settle(page, { requireLoadedFonts: true })).rejects.toThrow(
    'Visual capture cannot use failed fonts',
  );
});

test('visual capture rejects a stalled font request instead of timing into a fallback', async ({
  page,
}) => {
  const fontUrl = 'http://fonts.test/pending.woff2';
  let releaseFont!: () => void;
  const pendingFont = new Promise<void>((resolve) => {
    releaseFont = resolve;
  });
  await page.route(fontUrl, async (route) => {
    await pendingFont;
    await route.abort();
  });
  await page.setContent('<p>Font readiness</p>');
  await page.evaluate((url) => {
    const font = new FontFace('Pending visual font', `url("${url}")`);
    document.fonts.add(font);
    void font.load().catch(() => {});
  }, fontUrl);

  try {
    await expect(settle(page, { requireLoadedFonts: true })).rejects.toThrow(
      'Visual capture requires all requested fonts to finish loading',
    );
  } finally {
    releaseFont();
  }
});
