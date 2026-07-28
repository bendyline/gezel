import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const S = process.env.SCRATCH;
const token = readFileSync(S + '/home/runtime/auth-token', 'utf8').trim();
const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto(`https://127.0.0.1:45711/?token=${token}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="home-intro-article"]', { timeout: 40000 });
await page.waitForTimeout(3500);
await page.locator('.home-intro').screenshot({ path: S + '/' + (process.env.SHOT || 'after') + '-card.png' });
console.log('sections', await page.locator('[data-testid="home-intro-article"] section').evaluateAll((els) =>
  els.map((e) => ({ kind: e.getAttribute('data-section-kind'), h: Math.round(e.getBoundingClientRect().height) }))));
console.log('imgs', await page.locator('[data-testid="home-intro-article"] img').evaluateAll((els) =>
  els.map((e) => ({ alt: e.getAttribute('alt'), w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height), parent: e.parentElement?.className }))));
await browser.close();
