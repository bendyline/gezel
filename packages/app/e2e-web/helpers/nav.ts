/** Shared navigation helpers for the browser UX specs. */
import { type Page, expect } from '@playwright/test';
import { settle } from './determinism.js';

/** Navigate to the Home workshop and wait for it to mount. */
export async function gotoHome(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('home-workshop')).toBeVisible({ timeout: 30_000 });
  await settle(page);
}

/** Click a sidebar area link (tasks | craftbooks | scripts | history | settings). */
export async function openArea(page: Page, area: string): Promise<void> {
  await page.getByTestId(`sidebar-area-${area}`).click();
  await settle(page);
}

/** Expand a sidebar group (projects | gezels | documents) if collapsed. */
export async function expandGroup(page: Page, id: string): Promise<void> {
  const toggle = page.getByTestId(`sidebar-group-${id}`);
  await toggle.waitFor({ state: 'visible', timeout: 10_000 });
  if ((await toggle.getAttribute('aria-expanded')) === 'false') {
    await toggle.click();
    await settle(page);
  }
}

/** Open any tab via the app's unified navigation event (RecentTabInput shape). */
export async function openTab(page: Page, detail: Record<string, unknown>): Promise<void> {
  await page.evaluate((d) => {
    window.dispatchEvent(new CustomEvent('gezel:open-tab', { detail: d }));
  }, detail);
  await settle(page);
}

/** Open a top-level area view (projects | gezels | documents | tasks | craftbooks | scripts | history | settings). */
export async function openAreaView(page: Page, area: string): Promise<void> {
  await openTab(page, { kind: 'area', area });
}

export async function openProject(page: Page, projectId: string): Promise<void> {
  await openTab(page, { kind: 'project', id: projectId });
}

export async function openGezel(page: Page, gezelId: string): Promise<void> {
  await openTab(page, { kind: 'gezel', id: gezelId });
}

export async function openTask(page: Page, taskRef: string): Promise<void> {
  await openTab(page, { kind: 'task', ref: taskRef });
}
