import { describe, expect, it } from 'vitest';
import { THEME_FACTS, THEME_SEED_FILES, checkThemeReport } from './docblocks-theme-roundtrip.ts';

function validReport(): string {
  return [
    '# Brand theme alignment',
    '',
    '## Theme applied',
    `Inferred theme ${THEME_FACTS.themeId} from the brand reference. Headings use`,
    `${THEME_FACTS.headingFont}; body copy uses ${THEME_FACTS.bodyFont}. Accent`,
    `${THEME_FACTS.accentHex} on background ${THEME_FACTS.backgroundHex}.`,
    '',
    '## Page count',
    `The deck was ${THEME_FACTS.pagesBefore} pages before the theme and`,
    `${THEME_FACTS.pagesAfter} pages after; the brand spacing is tighter.`,
    '',
    '## Style conflicts',
    `${THEME_FACTS.conflictStyle} has no counterpart in the brand theme and kept its`,
    'original formatting. Everything else transferred.',
    '',
    '## Recommendation',
    'Ship the themed deck for review and ask the brand team whether to add a matching',
    'callout style before the next quarterly cycle.',
  ].join('\n');
}

describe('docblocks theme report grader', () => {
  it('accepts a fully tool-grounded report', () => {
    const result = checkThemeReport(validReport());
    expect(result.ok).toBe(true);
    expect(result.score).toBe(result.scoreMax);
  });

  it('rejects a plausible but invented font', () => {
    // The whole point: these values exist only in a tool response, so a
    // confident-sounding substitute is exactly the failure to catch.
    const result = checkThemeReport(
      validReport().replace(THEME_FACTS.headingFont, 'Helvetica Neue'),
    );
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toContain('fonts');
  });

  it('rejects a near-miss hex colour', () => {
    const result = checkThemeReport(validReport().replace(THEME_FACTS.accentHex, '#2E5E4F'));
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toContain('palette');
  });

  it('rejects page counts reported in the wrong order', () => {
    const swapped = validReport()
      .replace(`was ${THEME_FACTS.pagesBefore} pages before`, 'was PLACEHOLDER pages before')
      .replace(`${THEME_FACTS.pagesAfter} pages after`, `${THEME_FACTS.pagesBefore} pages after`)
      .replace('PLACEHOLDER', String(THEME_FACTS.pagesAfter));
    const result = checkThemeReport(swapped);
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toContain('page-delta');
  });

  it('rejects a report that whitewashes the style conflict', () => {
    const result = checkThemeReport(
      validReport().replace(
        `${THEME_FACTS.conflictStyle} has no counterpart in the brand theme and kept its\noriginal formatting. Everything else transferred.`,
        `Every style applied cleanly. ${THEME_FACTS.conflictStyle} is listed for reference.`,
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toContain('conflict-not-whitewashed');
  });

  it('allows an "all except" phrasing that names the conflict honestly', () => {
    const result = checkThemeReport(
      validReport().replace(
        'original formatting. Everything else transferred.',
        `original formatting. All styles applied except ${THEME_FACTS.conflictStyle}.`,
      ),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects an empty Recommendation section', () => {
    const result = checkThemeReport(
      validReport().replace(/## Recommendation[\s\S]*$/, '## Recommendation\n'),
    );
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toContain('recommendation');
  });

  it('keeps every gated value out of the seeded workspace', () => {
    // If a theme fact leaked into a seed file the model could copy it
    // without ever calling a tool, and the grounding gates would be
    // measuring transcription instead of retrieval.
    const seeded = THEME_SEED_FILES.map((file) => file.content)
      .join('\n')
      .toLowerCase();
    for (const value of [
      THEME_FACTS.themeId,
      THEME_FACTS.headingFont,
      THEME_FACTS.bodyFont,
      THEME_FACTS.accentHex,
      THEME_FACTS.backgroundHex,
      THEME_FACTS.conflictStyle,
    ]) {
      expect(seeded, `"${value}" must not be guessable from the seeded files`).not.toContain(
        value.toLowerCase(),
      );
    }
  });
});
