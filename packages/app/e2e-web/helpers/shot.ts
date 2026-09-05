/**
 * `shot()` — capture one UX frame to a stable, AI-addressable path and record
 * its metadata. Page-level (`fullPage`) or element-scoped (`clip`), with frozen
 * animations and volatile regions masked. In the visual configuration every
 * capture also compares against a reviewed baseline. Names come from
 * shot-registry.ts so filenames never drift.
 *
 *   await shot(page, 'composer', { area: 'chat', description: 'Empty composer', clip: page.getByTestId('chat-composer') });
 *   // -> ux-screenshots/chat/02-composer.png  (+ a manifest fragment)
 */
import { mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { type Locator, type Page, expect, test } from '@playwright/test';
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
  /** Logical viewport name; non-default sizes get distinct gallery paths. */
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
  const project = test.info().project.name;
  const regression = test.info().config.metadata.visualRegression === true;
  const viewport = opts.viewport ?? (project === 'desktop' ? 'default' : project);
  const themeSuffix = theme === 'dark' ? '-dark' : '';
  const suffix = `${themeSuffix}${viewport === 'default' ? '' : `-${viewport}`}`;
  const nn = shotNumber(opts.area, name);
  const file = `${nn}-${name}${suffix}.png`;
  const relativePath = `${opts.area}/${file}`;
  const absPath = join(SCREENSHOT_DIR, opts.area, file);
  await mkdir(dirname(absPath), { recursive: true });

  await settle(page);
  await expect(page.getByText('Loading view…', { exact: true })).toBeHidden();

  const maskedSelectors = [
    ...(opts.noDefaultMasks ? [] : VOLATILE_SELECTORS),
    ...(opts.mask ?? []),
  ];
  const masks: Locator[] = maskedSelectors.map((sel) => page.locator(sel));

  // Neutral redaction color — Playwright's default mask is alarming magenta.
  const maskColor = '#9aa0a6';

  if (regression) {
    const snapshot = [opts.area, `${nn}-${name}${themeSuffix}.png`];
    const options = {
      mask: masks,
      maskColor,
      animations: 'disabled' as const,
      scale: 'css' as const,
    };
    if (opts.clip) {
      await opts.clip.scrollIntoViewIfNeeded();
      await expect(opts.clip).toBeInViewport({ ratio: 1 });
      await expect(opts.clip).toHaveScreenshot(snapshot, options);
    } else {
      await expect(page).toHaveScreenshot(snapshot, {
        ...options,
        fullPage: opts.fullPage ?? true,
      });
    }
  }

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
    regression,
    masked: maskedSelectors,
    spec: currentSpec(),
  };
  await writePart(entry);
  return relativePath;
}
