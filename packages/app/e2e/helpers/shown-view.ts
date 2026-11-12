import type { Locator, Page } from '@playwright/test';

/**
 * The destination on screen. Recently visited views stay mounted but hidden
 * (KeepAliveHost), so Home's chat can hold the very thread a project shows,
 * and a selector that can match in more than one view finds the hidden copy
 * first. Scope those selectors here. Pass the string into `page.evaluate`.
 */
export const SHOWN_VIEW_SELECTOR = '.keep-alive-view[data-shown]';

export function shownView(page: Page): Locator {
  return page.locator(SHOWN_VIEW_SELECTOR);
}
