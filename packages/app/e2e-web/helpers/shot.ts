/**
 * `shot()` — capture one UX frame to a stable, AI-addressable path and record
 * its metadata. Page-level (`fullPage`) or element-scoped (`clip`), with frozen
 * animations and volatile regions masked. Names come from shot-registry.ts so
 * filenames never drift.
 *
 *   await shot(page, 'composer', { area: 'chat', description: 'Empty composer', clip: page.getByTestId('chat-composer') });
 *   // -> ux-screenshots/chat/02-composer.png  (+ a manifest fragment)
 */
import { mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { type Locator, type Page, test } from '@playwright/test';
import { VOLATILE_SELECTORS, settle } from './determinism.js';
import { SCREENSHOT_DIR, type ShotEntry, type ShotTheme, writePart } from './manifest.js';
import { type ShotArea, shotNumber } from './shot-registry.js';

export interface ShotOptions {
  area: ShotArea;
  /** One-line human/AI description of what the frame shows. */
  description: string;
  /** Element-scoped capture; omit for a full-page shot. */
  clip?: Locator;
  /** Extra mask selectors, applied on top of the default volatile regions. */
  mask?: string[];
  theme?: ShotTheme;
  /** Logical viewport name (matches the Playwright project); recorded only. */
  viewport?: string;
  /** Page shots only; defaults to true. */
  fullPage?: boolean;
  /** Selector string to record for an element clip / stabilization anchor. */
  selector?: string;
  /** Skip the default volatile masks (rare — e.g. an intentionally full frame). */
  noDefaultMasks?: boolean;
}

function currentSpec(): string {
  try {
    return basename(test.info().file);
  } catch {
    return '';
  }
}

export async function shot(page: Page, name: string, opts: ShotOptions): Promise<string> {
  const theme: ShotTheme = opts.theme ?? 'light';
  const viewport = opts.viewport ?? 'default';
  const suffix = theme === 'dark' ? '-dark' : '';
  const nn = shotNumber(opts.area, name);
  const file = `${nn}-${name}${suffix}.png`;
  const relativePath = `${opts.area}/${file}`;
  const absPath = join(SCREENSHOT_DIR, opts.area, file);
  await mkdir(dirname(absPath), { recursive: true });

  await settle(page);

  const maskedSelectors = [
    ...(opts.noDefaultMasks ? [] : VOLATILE_SELECTORS),
    ...(opts.mask ?? []),
  ];
  const masks: Locator[] = maskedSelectors.map((sel) => page.locator(sel));

  // Neutral redaction color — Playwright's default mask is alarming magenta.
  const maskColor = '#9aa0a6';

  if (opts.clip) {
    await opts.clip.scrollIntoViewIfNeeded();
    await opts.clip.screenshot({ path: absPath, mask: masks, maskColor, animations: 'disabled' });
  } else {
    await page.screenshot({
      path: absPath,
      fullPage: opts.fullPage ?? true,
      mask: masks,
      maskColor,
      animations: 'disabled',
    });
  }

  const entry: ShotEntry = {
    key: `${opts.area}/${name}${suffix}`,
    name,
    area: opts.area,
    relativePath,
    description: opts.description,
    scope: opts.clip ? 'element' : 'page',
    selector: opts.selector,
    theme,
    viewport,
    masked: maskedSelectors,
    spec: currentSpec(),
  };
  await writePart(entry);
  return relativePath;
}
