import { describe, expect, it } from 'vitest';
import { inferTargetProject } from './project-routing.js';

const sessions = [
  { projectId: 'default' },
  { projectId: 'launch' },
  { projectId: 'launch', archived: false },
  { projectId: 'old', archived: true },
];

describe('inferTargetProject', () => {
  it('honours an explicit project', () => {
    expect(inferTargetProject(sessions, 'other', 'default')).toBe('other');
  });
  it("keeps the sender's non-default project", () => {
    expect(inferTargetProject(sessions, undefined, 'mine')).toBe('mine');
  });
  it('routes to the single active non-default project when landing on default', () => {
    expect(inferTargetProject(sessions, undefined, 'default')).toBe('launch');
    expect(inferTargetProject(sessions, undefined, undefined)).toBe('launch');
  });
  it('does not guess between several', () => {
    expect(inferTargetProject([...sessions, { projectId: 'second' }], undefined, 'default')).toBe(
      'default',
    );
  });
  it('ignores archived sessions', () => {
    expect(inferTargetProject([{ projectId: 'old', archived: true }], undefined, 'default')).toBe(
      'default',
    );
  });
});
