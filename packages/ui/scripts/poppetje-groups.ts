/**
 * Screenshot each gallery <section class="group"> as its own PNG so the
 * groups can be reviewed one image at a time (the full overview.png is
 * ~11k px tall). Run after poppetje-gallery.tsx.
 *
 *   pnpm --filter @bendyline/gezel-ui exec tsx scripts/poppetje-groups.ts
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const _dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(_dirname, '..', '..', '..', 'tmp', 'poppetjes');

async function main(): Promise<void> {
  await mkdir(join(outDir, 'groups'), { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(pathToFileURL(join(outDir, 'index.html')).toString(), { waitUntil: 'load' });

  const sections = page.locator('section.group');
  const count = await sections.count();
  for (let i = 0; i < count; i++) {
    const section = sections.nth(i);
    const title = (await section.locator('h2').textContent()) ?? `group-${i}`;
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    await section.scrollIntoViewIfNeeded();
    await section.screenshot({
      path: join(outDir, 'groups', `${String(i).padStart(2, '0')}-${slug}.png`),
    });
  }
  console.log(`[groups] ${count} group PNGs written to ${join(outDir, 'groups')}`);
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
