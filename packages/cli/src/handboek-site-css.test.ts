import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CATALOG_GROUND_TONES } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { BASELINE_CSS, SITE_GROUND_COLORS } from './handboek-site-css.js';

// The app's palette is the source of truth for the grounds; the site copies it.
const foundation = readFileSync(
  fileURLToPath(new URL('../../ui/src/styles/foundation.css', import.meta.url)),
  'utf8',
);
const appLight = foundation.match(/^:root \{([\s\S]*?)^\}/m)?.[1] ?? '';
const appDark =
  foundation.match(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)^ {2}\}/m)?.[1] ?? '';
const appGround = (source: string, tone: string) =>
  source.match(new RegExp(`--gezel-ground-${tone}:\\s*(#[0-9a-f]{6})`))?.[1];

describe('Handboek site craftbook grounds', () => {
  it("match the app's ground colors in light and dark", () => {
    expect(appLight).not.toBe('');
    expect(appDark).not.toBe('');
    for (const tone of CATALOG_GROUND_TONES) {
      expect(SITE_GROUND_COLORS[tone].light, `light ${tone}`).toBe(appGround(appLight, tone));
      expect(SITE_GROUND_COLORS[tone].dark, `dark ${tone}`).toBe(appGround(appDark, tone));
    }
  });

  it('defines a token and a rule for every tone', () => {
    for (const tone of CATALOG_GROUND_TONES) {
      expect(BASELINE_CSS).toContain(`--hb-ground-${tone}: ${SITE_GROUND_COLORS[tone].light};`);
      expect(BASELINE_CSS).toContain(`--hb-ground-${tone}: ${SITE_GROUND_COLORS[tone].dark};`);
      expect(BASELINE_CSS).toContain(
        `[data-ground="${tone}"] { --hb-mark-ground: var(--hb-ground-${tone}); }`,
      );
    }
    expect(BASELINE_CSS).not.toContain('undefined');
  });
});
