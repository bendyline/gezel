import { GezelClient } from '@bendyline/gezel-client';

/**
 * Settings — a tour of the section nav. One element-clip per meaningful section
 * panel (provider managers live inside their section panels, so clipping the
 * section covers them).
 */
import { expect, test } from './fixtures/test.js';
import { settle } from './helpers/determinism.js';
import { gotoHome, openAreaView } from './helpers/nav.js';
import { shot } from './helpers/shot.js';

const SECTIONS = [
  {
    id: 'general',
    name: 'general',
    desc: 'Settings — General (theme, engagement, window behavior)',
  },
  { id: 'team', name: 'team', desc: 'Settings — Your Team (meester / klerk pickers)' },
  {
    id: 'folders',
    name: 'folders',
    desc: 'Settings — Folders (workspace / documents / artifacts)',
  },
  {
    id: 'defaults',
    name: 'ai-defaults',
    desc: 'Settings — Artificial Intelligence (default provider + model)',
  },
  { id: 'anthropic', name: 'provider-anthropic', desc: 'Settings — Anthropic Claude provider' },
  { id: 'openai', name: 'provider-openai', desc: 'Settings — OpenAI provider' },
  { id: 'ollama', name: 'provider-ollama', desc: 'Settings — Ollama provider / model manager' },
  { id: 'securityCompliance', name: 'security', desc: 'Settings — Security & Compliance levels' },
  { id: 'about', name: 'about', desc: 'Settings — About / diagnostics' },
];

test.describe('settings', () => {
  test('section tour', async ({ page }) => {
    await gotoHome(page);
    await openAreaView(page, 'settings');

    for (const s of SECTIONS) {
      await page.getByTestId(`settings-nav-${s.id}`).click();
      const panel = page.getByTestId(`settings-section-${s.id}`);
      await expect(panel).toBeVisible();
      await settle(page);
      await shot(page, s.name, {
        area: 'settings',
        clip: panel,
        selector: `[data-testid=settings-section-${s.id}]`,
        description: s.desc,
      });
    }
  });

  test('DwarfStar appears in the header engine pill', async ({ page, daemon }) => {
    const client = new GezelClient({ baseUrl: daemon.baseURL, token: daemon.token });
    await client.updateConfig({ provider: 'ds4' });
    try {
      // The home workshop waits for a usable chat model before it mounts. This
      // fixture intentionally has no 80+ GiB DS4 weights installed, but the
      // global header (and therefore the engine pill) is still fully usable.
      await page.goto('/');
      const pill = page.locator('.engine-pill-root');
      await expect(pill.getByRole('button', { name: /DwarfStar/i })).toBeVisible();
      await settle(page);
      await shot(page, 'engine-pill-ds4', {
        area: 'shell',
        clip: pill,
        selector: '.engine-pill-root',
        description: 'Header — DwarfStar on-device engine status pill',
      });

      // Windows has no native DS4 build, but an already-selected DS4 provider
      // may point at an external server. Its settings must remain reachable.
      await openAreaView(page, 'settings');
      await page.getByTestId('settings-nav-ds4').click();
      const panel = page.getByTestId('settings-section-ds4');
      await expect(panel).toBeVisible();
      await settle(page);
      await shot(page, 'provider-ds4', {
        area: 'settings',
        clip: panel,
        selector: '[data-testid=settings-section-ds4]',
        description: 'Settings — DeepSeek V4 / ds4 model manager and device-fit guidance',
      });
    } finally {
      await client.updateConfig({ provider: 'copilot' });
    }
  });
});
