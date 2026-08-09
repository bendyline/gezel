import { describe, expect, it } from 'vitest';
import { shouldDisplayIntent } from './intent-display.js';

describe('shouldDisplayIntent', () => {
  it('hides provider implementation breadcrumbs already represented by tool rows', () => {
    expect(shouldDisplayIntent('Using MCP tool call')).toBe(false);
    expect(shouldDisplayIntent('USING SHELL')).toBe(false);
    expect(shouldDisplayIntent('reasoning')).toBe(false);
  });

  it('keeps meaningful high-level phase announcements', () => {
    expect(shouldDisplayIntent('Reviewing the final draft')).toBe(true);
  });
});
