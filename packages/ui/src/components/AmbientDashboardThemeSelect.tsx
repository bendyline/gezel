import type { AmbientDashboardTheme, AmbientDashboardThemeSummary } from '@bendyline/gezel';
import { FONT_FALLBACKS, resolveFontFamily, resolveTheme } from '@bendyline/squisq/schemas';
import { Select } from '../primitives/index.js';

/**
 * The same compact visual vocabulary as Squisq's ThemePicker: render the
 * theme name on its own paper, then show the three colors that most strongly
 * identify it. `compact` is the selected value in the trigger; the menu card
 * additionally carries the catalog description.
 */
function AmbientThemePreview({
  summary,
  compact = false,
}: {
  summary: AmbientDashboardThemeSummary;
  compact?: boolean;
}) {
  const theme = resolveTheme(summary.id);
  const titleFont = resolveFontFamily(theme.typography.titleFont, FONT_FALLBACKS.sans);

  return (
    <span
      className={`ambient-theme-preview${compact ? ' ambient-theme-preview--compact' : ''}`}
      data-theme-id={summary.id}
    >
      <span
        className="ambient-theme-name-chip"
        style={{
          background: theme.colors.background,
          borderColor: theme.colors.backgroundLight,
          color: theme.colors.text,
          fontFamily: titleFont,
        }}
      >
        {summary.name}
      </span>
      <span className="ambient-theme-swatches" aria-hidden="true">
        <span className="ambient-theme-swatch" style={{ background: theme.colors.primary }} />
        <span className="ambient-theme-swatch" style={{ background: theme.colors.secondary }} />
        <span className="ambient-theme-swatch" style={{ background: theme.colors.highlight }} />
      </span>
      {!compact && summary.description && (
        <span className="ambient-theme-description" aria-hidden="true">
          {summary.description}
        </span>
      )}
    </span>
  );
}

export function AmbientDashboardThemeSelect({
  value,
  themes,
  disabled,
  labelledBy,
  onValueChange,
}: {
  value: AmbientDashboardTheme;
  themes: AmbientDashboardThemeSummary[];
  disabled?: boolean;
  labelledBy: string;
  onValueChange: (value: AmbientDashboardTheme) => void;
}) {
  const selectedTheme = themes.find((theme) => theme.id === value);

  return (
    <Select.Root
      value={value}
      onValueChange={(next) => onValueChange(next as AmbientDashboardTheme)}
      disabled={disabled}
    >
      <Select.Trigger
        aria-labelledby={labelledBy}
        className="ambient-theme-select-trigger"
        style={{ width: '100%', marginTop: '0.25rem' }}
      >
        {selectedTheme && <AmbientThemePreview summary={selectedTheme} compact />}
      </Select.Trigger>
      <Select.Content className="ambient-theme-select-menu" align="start">
        {themes.map((theme) => (
          <Select.Item key={theme.id} value={theme.id} textValue={theme.name}>
            <AmbientThemePreview summary={theme} />
          </Select.Item>
        ))}
      </Select.Content>
    </Select.Root>
  );
}
