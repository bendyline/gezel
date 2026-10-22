import { availableProjectViews } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { OFFERED_PROJECT_VIEWS, PROJECT_VIEWS } from './registry.js';

describe('the project views this build offers', () => {
  it('offers a code project every view', () => {
    expect(availableProjectViews({}, OFFERED_PROJECT_VIEWS)).toEqual([
      'village',
      'guide',
      'diagram',
      'reports',
      'gallery',
      'timeline',
    ]);
  });

  it('offers a writing project all but the Village and Guide, unless opted in', () => {
    expect(
      availableProjectViews({ projectTypeId: 'content-writing' }, OFFERED_PROJECT_VIEWS),
    ).toEqual(['diagram', 'reports', 'gallery', 'timeline']);
    expect(
      availableProjectViews(
        { projectTypeId: 'content-writing', tabVisibility: { map: true } },
        OFFERED_PROJECT_VIEWS,
      ),
    ).toEqual(['village', 'guide', 'diagram', 'reports', 'gallery', 'timeline']);
  });

  it('offers a picture folder its reports, gallery and timeline', () => {
    expect(
      availableProjectViews(
        { projectTypeId: 'media-production', properties: { 'gezel.folderKind': 'pictures' } },
        OFFERED_PROJECT_VIEWS,
      ),
    ).toEqual(['reports', 'gallery', 'timeline']);
  });

  it('gives every view a distinct label and a one-line hint for the menu', () => {
    const labels = PROJECT_VIEWS.map((v) => v.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const view of PROJECT_VIEWS) expect(view.hint.length).toBeGreaterThan(0);
  });
});
