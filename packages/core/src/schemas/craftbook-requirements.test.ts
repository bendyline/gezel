import { describe, expect, it } from 'vitest';
import {
  type CraftbookRequirement,
  craftbookRequirementsMet,
  unmetCraftbookRequirements,
} from './craftbook.js';

const PR_REVIEW: CraftbookRequirement[] = [{ kind: 'github' }, { kind: 'non-main-branch' }];

describe('craftbook requirements', () => {
  it('treats no requirements as always applicable', () => {
    expect(craftbookRequirementsMet(undefined, { hasGitHub: false, branch: null })).toBe(true);
    expect(craftbookRequirementsMet([], { hasGitHub: false, branch: null })).toBe(true);
  });

  it('hides PR review on a non-GitHub project', () => {
    const unmet = unmetCraftbookRequirements(PR_REVIEW, { hasGitHub: false, branch: null });
    expect(unmet).toContain('a GitHub-connected project');
    expect(craftbookRequirementsMet(PR_REVIEW, { hasGitHub: false, branch: null })).toBe(false);
  });

  it('hides PR review on a GitHub project that is on main/master', () => {
    expect(craftbookRequirementsMet(PR_REVIEW, { hasGitHub: true, branch: 'main' })).toBe(false);
    expect(craftbookRequirementsMet(PR_REVIEW, { hasGitHub: true, branch: 'master' })).toBe(false);
    expect(unmetCraftbookRequirements(PR_REVIEW, { hasGitHub: true, branch: 'main' })).toContain(
      'a branch other than main/master',
    );
  });

  it('hides PR review when the branch is unknown', () => {
    expect(craftbookRequirementsMet(PR_REVIEW, { hasGitHub: true, branch: null })).toBe(false);
  });

  it('offers PR review on a GitHub project on a feature branch', () => {
    expect(craftbookRequirementsMet(PR_REVIEW, { hasGitHub: true, branch: 'feature/x' })).toBe(
      true,
    );
    expect(unmetCraftbookRequirements(PR_REVIEW, { hasGitHub: true, branch: 'feature/x' })).toEqual(
      [],
    );
  });
});
