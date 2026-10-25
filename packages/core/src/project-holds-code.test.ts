import { describe, expect, it } from 'vitest';
import { FOLDER_KIND_PROPERTY } from './folder-kind.js';
import { projectHoldsCode } from './project-holds-code.js';

const applied = (id: string, category?: string) => ({
  projectType: { id, ...(category ? { category } : {}) },
});

describe('projectHoldsCode', () => {
  it('lets a recorded folder kind decide, either way', () => {
    expect(projectHoldsCode({ properties: { [FOLDER_KIND_PROPERTY]: 'code' } })).toBe(true);
    expect(
      projectHoldsCode({
        properties: { [FOLDER_KIND_PROPERTY]: 'documents' },
        github: { url: 'https://github.com/x/y' },
      }),
    ).toBe(false);
  });

  // A fresh Software Project used to fail every check until detection saw
  // code, because its type does not extend a coding taxonomy id.
  it('counts a project made from a code-category type from the start', () => {
    expect(projectHoldsCode(applied('software-project', 'code'))).toBe(true);
  });

  it('counts a Software Project stamped before the category was recorded', () => {
    expect(projectHoldsCode(applied('software-project'))).toBe(true);
  });

  // Data Analysis is category `data` but extends the coding `data-analysis`
  // id; a category must never take a codebase away.
  it('keeps a typed project whose type extends a coding id', () => {
    expect(
      projectHoldsCode({ ...applied('data-analysis', 'data'), projectTypeId: 'data-analysis' }),
    ).toBe(true);
  });

  it('does not count a non-code type on its own', () => {
    expect(projectHoldsCode(applied('freelance-office', 'money'))).toBe(false);
  });

  it('falls back to a coding type or a linked repository', () => {
    expect(projectHoldsCode({ detectedProjectType: { id: 'web-app' } })).toBe(true);
    expect(projectHoldsCode({ projectTypeId: 'cli-tool' })).toBe(true);
    expect(projectHoldsCode({ github: { url: 'https://github.com/x/y' } })).toBe(true);
  });

  it('does not count a plain project', () => {
    expect(projectHoldsCode({})).toBe(false);
    expect(projectHoldsCode(applied('trip-planner'))).toBe(false);
  });
});
