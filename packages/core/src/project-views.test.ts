import { describe, expect, it } from 'vitest';
import { FOLDER_KIND_PROPERTY } from './folder-kind.js';
import {
  KNOWN_PROJECT_VIEWS,
  type ProjectViewId,
  availableProjectViews,
  defaultProjectView,
  isVillageProject,
  projectViewsTabDefault,
  resolveProjectView,
} from './project-views.js';
import { ProjectSchema } from './schemas/project.js';

const ALL: readonly ProjectViewId[] = KNOWN_PROJECT_VIEWS;
const kind = (k: string) => ({ properties: { [FOLDER_KIND_PROPERTY]: k } });

describe('project views', () => {
  it('offers the Village on code-ish and unclassified projects, as the old tab did', () => {
    expect(isVillageProject({})).toBe(true);
    expect(isVillageProject({ detectedProjectType: { id: 'node-app' } })).toBe(true);
    expect(isVillageProject({ detectedProjectType: { id: 'content-writing' } })).toBe(false);
    expect(
      availableProjectViews({ projectTypeId: 'media-production', tabVisibility: { map: true } }, [
        'village',
      ]),
    ).toEqual(['village']);
  });

  it('leaves the diagram out of picture folders and keeps the offered order', () => {
    expect(availableProjectViews(kind('pictures'), ALL)).toEqual([
      'village',
      'reports',
      'gallery',
      'timeline',
    ]);
    expect(availableProjectViews(kind('code'), ['gallery', 'village'])).toEqual([
      'gallery',
      'village',
    ]);
  });

  it('offers the guide where the Village is, but not for a picture folder', () => {
    expect(availableProjectViews(kind('code'), ['village', 'guide'])).toEqual(['village', 'guide']);
    expect(availableProjectViews({}, ['guide'])).toEqual(['guide']);
    expect(availableProjectViews(kind('pictures'), ['guide'])).toEqual([]);
    expect(
      availableProjectViews({ detectedProjectType: { id: 'content-writing' } }, ['guide']),
    ).toEqual([]);
  });

  it('opens on the view that suits what the folder mostly holds', () => {
    expect(defaultProjectView(kind('code'))).toBe('village');
    expect(defaultProjectView(kind('pictures'))).toBe('gallery');
    expect(defaultProjectView(kind('documents'))).toBe('gallery');
    expect(defaultProjectView({})).toBe('village');
    expect(defaultProjectView({ detectedProjectType: { id: 'content-writing' } })).toBe('gallery');
  });

  it('keeps the stored choice, and passes over one this build does not offer', () => {
    expect(resolveProjectView({ ...kind('code'), selectedView: 'diagram' }, ALL)).toBe('diagram');
    expect(resolveProjectView({ ...kind('code'), selectedView: 'heatmap' }, ALL)).toBe('village');
    const pictures = { ...kind('pictures'), selectedView: 'diagram' };
    expect(resolveProjectView(pictures, availableProjectViews(pictures, ALL))).toBe('gallery');
    expect(resolveProjectView({ selectedView: 'gallery' }, ['village'])).toBe('village');
    expect(resolveProjectView({}, [])).toBeNull();
  });

  it('shows the Views tab by default only when some view fits', () => {
    const writing = { detectedProjectType: { id: 'content-writing' } };
    expect(projectViewsTabDefault(writing, ['village'])).toBe(false);
    expect(projectViewsTabDefault(writing, ['village', 'gallery'])).toBe(true);
    expect(projectViewsTabDefault({}, ['village'])).toBe(true);
  });

  it('round-trips a view id a newer build wrote, and drops a malformed one', () => {
    const base = { id: 'p', name: 'P', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
    expect(ProjectSchema.parse({ ...base, selectedView: 'heatmap' }).selectedView).toBe('heatmap');
    const bad = ProjectSchema.parse({ ...base, selectedView: 'Not A View!' });
    expect(bad.selectedView).toBeUndefined();
    expect(bad.name).toBe('P');
  });
});
