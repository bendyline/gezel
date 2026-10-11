import { type Page, expect } from '@playwright/test';

const GREETING_TAB = /^Good (morning|afternoon|evening)$/;

/**
 * Open the Home greeting band on its greeting panel, whatever state the page
 * opened in. Choosing the tab whose panel is already open rolls the band up,
 * and whether the band starts open depends on the saved preference and on
 * whether the meester's introduction has landed yet. Any press latches the
 * band against that auto-collapse, so a second press settles it.
 */
export async function openGreetingTab(page: Page): Promise<void> {
  const tab = page.getByRole('tab', { name: GREETING_TAB });
  await tab.click();
  if ((await tab.getAttribute('aria-expanded')) !== 'true') await tab.click();
  await expect(tab).toHaveAttribute('aria-expanded', 'true');
}
