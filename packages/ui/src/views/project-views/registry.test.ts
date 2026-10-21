import { availableProjectViews } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { OFFERED_PROJECT_VIEWS, PROJECT_VIEWS } from './registry.js';

describe('the project views this build offers', () => {
  it('offers a code project the Village and its Guide, so the tab carries a menu', () => {
    expect(availableProjectViews({}, OFFERED_PROJECT_VIEWS)).toEqual(['village', 'guide']);
  });

  it('offers a writing project neither, unless the person opted into the Village', () => {
    expect(
      availableProjectViews({ projectTypeId: 'content-writing' }, OFFERED_PROJECT_VIEWS),
    ).toEqual([]);
    expect(
      availableProjectViews(
        { projectTypeId: 'content-writing', tabVisibility: { map: true } },
        OFFERED_PROJECT_VIEWS,
      ),
    ).toEqual(['village', 'guide']);
  });

  it('gives every view a distinct label and a one-line hint for the menu', () => {
    const labels = PROJECT_VIEWS.map((v) => v.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const view of PROJECT_VIEWS) expect(view.hint.length).toBeGreaterThan(0);
  });
});
