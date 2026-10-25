import { describe, expect, it } from 'vitest';
import { findProjectByReference, projectNotFoundMessage } from './project-ref.js';

const projects = [{ id: 'existing-work', name: 'Existing Work' }];

describe('project references', () => {
  it('resolves existing ids and case-insensitive display names without inventing projects', () => {
    expect(findProjectByReference(projects, 'existing-work')).toBe(projects[0]);
    expect(findProjectByReference(projects, ' EXISTING WORK ')).toBe(projects[0]);
    expect(findProjectByReference(projects, 'Fresh Work')).toBeUndefined();
  });

  it('does not prescribe tools without evidence that they are available', () => {
    const message = projectNotFoundMessage('Fresh Work', projects);
    expect(message).toContain('"existing-work" (Existing Work)');
    expect(message).toContain('[runtime: non-retryable]');
    expect(message).not.toMatch(/`(?:start_project|start_work|list_projects)`/);
    expect(message).not.toContain('start_work(');
  });

  it('recovers a new-project name passed as an existing reference through the wired launcher', () => {
    const message = projectNotFoundMessage('Fresh Work', projects, ['start_work']);
    expect(message).toContain('start_work({ "option": "new-project" })');
    expect(message).toContain('without a `project` argument');
    expect(message).toContain('optional `name` argument');
    expect(message).not.toContain('start_project');
  });
});
