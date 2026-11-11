import { type Locator, type Page, expect } from '@playwright/test';

/**
 * The two Settings nav groups, "Artificial intelligence" and "More settings".
 * Both start folded, so a row inside one is not in the page until its group is
 * unfolded.
 */
const SETTINGS_NAV_GROUPS = ['ai', 'more'] as const;

/** Unfold a Settings nav group; a group that is already open is left alone. */
export async function unfoldSettingsGroup(
  page: Page,
  group: (typeof SETTINGS_NAV_GROUPS)[number],
): Promise<void> {
  const toggle = page.getByTestId(`settings-nav-group-${group}`);
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

/** Unfold every Settings nav group, for a spec that walks the whole list. */
export async function unfoldSettingsGroups(page: Page): Promise<void> {
  for (const group of SETTINGS_NAV_GROUPS) await unfoldSettingsGroup(page, group);
}

/**
 * Bring a Settings nav row on screen, unfolding groups only while the row is
 * still missing. A row that waits on a probe (a provider page that shows once
 * the install uses it) may leave both groups open; the caller's own click or
 * assertion then waits for it.
 */
export async function revealSettingsNavItem(page: Page, item: Locator): Promise<void> {
  await expect(page.getByTestId('settings-nav-general')).toBeVisible({ timeout: 15_000 });
  for (const group of SETTINGS_NAV_GROUPS) {
    if (await item.isVisible()) return;
    await unfoldSettingsGroup(page, group);
  }
}

/** Open a Settings section from the nav by its id, wherever it sits. */
export async function openSettingsSection(page: Page, id: string): Promise<void> {
  const item = page.getByTestId(`settings-nav-${id}`);
  await revealSettingsNavItem(page, item);
  await item.click();
}
