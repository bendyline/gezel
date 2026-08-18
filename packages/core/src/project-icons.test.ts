import { describe, expect, it } from 'vitest';
import { ProjectIconIdSchema, projectTypeIcon, resolveProjectIcon } from './project-icons.js';

describe('project maker marks', () => {
  it('uses explicit type marks before deterministic inference', () => {
    expect(projectTypeIcon({ id: 'web-app', icon: 'palette', category: 'code' })).toBe('palette');
    expect(projectTypeIcon({ id: 'web-app' })).toBe('code');
    expect(projectTypeIcon({ id: 'community-api-kit', tags: ['backend'], category: 'other' })).toBe(
      'server',
    );
    expect(projectTypeIcon({ id: 'unknown-kit', category: 'writing' })).toBe('quill');
  });

  it('keeps the vocabulary finite and schema-safe', () => {
    expect(ProjectIconIdSchema.parse('code')).toBe('code');
    expect(() => ProjectIconIdSchema.parse('arbitrary-emoji')).toThrow();
  });

  it('resolves project inheritance in one stable order', () => {
    expect(
      resolveProjectIcon({
        icon: 'heart',
        projectType: { id: 'web-app', icon: 'code' },
        projectTypeId: 'email',
      }),
    ).toBe('heart');
    expect(resolveProjectIcon({ projectType: { id: 'custom', icon: 'palette' } })).toBe('palette');
    expect(resolveProjectIcon({ projectTypeId: 'api-service' })).toBe('server');
    expect(resolveProjectIcon({ detectedProjectType: { id: 'content-writing' } })).toBe('quill');
    expect(resolveProjectIcon({ github: { url: 'https://github.com/o/r' } })).toBe('branch');
    expect(resolveProjectIcon({ workingDir: '/work/repo' })).toBe('folder');
    expect(resolveProjectIcon({})).toBe('sheet');
  });
});
