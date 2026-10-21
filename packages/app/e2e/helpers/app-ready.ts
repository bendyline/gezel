import { type Page, expect } from '@playwright/test';

/** The live shell mounts behind the local Home reader before its handoff finishes. */
export async function waitForAppReady(page: Page): Promise<void> {
  await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#startup-home')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.locator('#root')).not.toHaveAttribute('inert');
}
