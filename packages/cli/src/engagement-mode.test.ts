import { describe, expect, it } from 'vitest';
import {
  CLI_ENGAGEMENT_MODES,
  cliEngagementModeOption,
  parseCliEngagementMode,
} from './engagement-mode.js';

describe('CLI engagement modes', () => {
  it('maps the four terminal postures onto the persisted engagement modes', () => {
    expect(CLI_ENGAGEMENT_MODES.map(({ name, mode }) => [name, mode])).toEqual([
      ['read-only', 'off'],
      ['reactive', 'reactive'],
      ['reactive+tasks', 'scheduled'],
      ['full-play', 'proactive'],
    ]);
  });

  it('accepts friendly spellings and the existing persisted names', () => {
    expect(parseCliEngagementMode('read only')).toBe('off');
    expect(parseCliEngagementMode('Reactive + Tasks')).toBe('scheduled');
    expect(parseCliEngagementMode('full_play')).toBe('proactive');
    expect(parseCliEngagementMode('scheduled')).toBe('scheduled');
    expect(parseCliEngagementMode('anything-goes')).toBeNull();
  });

  it('uses full play for an unset config and formats every persisted mode', () => {
    expect(cliEngagementModeOption(undefined).name).toBe('full-play');
    expect(cliEngagementModeOption('off').label).toBe('Read-only');
    expect(cliEngagementModeOption('reactive').label).toBe('Reactive');
    expect(cliEngagementModeOption('scheduled').label).toBe('Reactive + tasks');
    expect(cliEngagementModeOption('proactive').label).toBe('Full play');
  });
});
