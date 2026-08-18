import { AmbientDashboardThemeSchema } from '@bendyline/gezel';
import { getThemeSummaries } from '@bendyline/squisq/schemas';
import { describe, expect, it } from 'vitest';
import { AMBIENT_DASHBOARD_THEMES, DEFAULT_THEME_ID } from './dashboard-themes.js';

describe('ambient dashboard theme catalog', () => {
  it('stays in lockstep with Squisq built-ins', () => {
    expect(getThemeSummaries().map((theme) => theme.id)).toEqual(
      AmbientDashboardThemeSchema.options,
    );
    expect(AMBIENT_DASHBOARD_THEMES).toEqual(getThemeSummaries());
  });

  it("defaults to Gezel's warm dark theme", () => {
    expect(DEFAULT_THEME_ID).toBe('gezellig');
  });
});
