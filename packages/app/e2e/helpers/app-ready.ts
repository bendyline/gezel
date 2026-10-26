import { type Page, expect } from '@playwright/test';

/** The live shell mounts behind the local Home reader before its handoff finishes. */
export async function waitForAppReady(page: Page): Promise<void> {
  await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 60_000 });
  // theme-init adds a module script dynamically. DOMContentLoaded and React's
  // sidebar can precede it; load waits for it to mount the startup overlay.
  // Check after the sidebar so this is the live document, not the local reader.
  await page.waitForLoadState('load', { timeout: 60_000 });
  await expect(page.locator('#startup-home')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.locator('#root')).not.toHaveAttribute('inert');
}
