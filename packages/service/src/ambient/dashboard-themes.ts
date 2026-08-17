import {
  type AmbientDashboardTheme,
  type AmbientDashboardThemeSummary,
  AmbientDashboardThemeSummarySchema,
} from '@bendyline/gezel';
import { getThemeSummaries } from '@bendyline/squisq/schemas';

/** Gezel's warm dark Squisq theme is the ambient-display default. */
export const DEFAULT_THEME_ID: AmbientDashboardTheme = 'gezellig';

/**
 * Parse Squisq's live catalog through the public wire schema. This fails fast
 * in development if Squisq adds or removes a built-in without the core mirror
 * being updated alongside it.
 */
export const AMBIENT_DASHBOARD_THEMES: AmbientDashboardThemeSummary[] =
  AmbientDashboardThemeSummarySchema.array().parse(getThemeSummaries());
