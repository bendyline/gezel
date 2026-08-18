import { describe, expect, it } from 'vitest';
import { titleCaseRole } from './role-title.js';

describe('titleCaseRole', () => {
  it('title-cases an all-lowercase job title', () => {
    expect(titleCaseRole('application security engineer')).toBe('Application Security Engineer');
  });

  it('leaves a word that already carries uppercase alone', () => {
    expect(titleCaseRole('Chief Security Officer')).toBe('Chief Security Officer');
    expect(titleCaseRole('UI/UX Designer')).toBe('UI/UX Designer');
    expect(titleCaseRole('iOS developer')).toBe('iOS Developer');
  });

  it('restores acronyms rather than sentence-casing them', () => {
    expect(titleCaseRole('qa engineer')).toBe('QA Engineer');
    expect(titleCaseRole('ui/ux designer')).toBe('UI/UX Designer');
    expect(titleCaseRole('seo specialist')).toBe('SEO Specialist');
  });

  it('keeps minor words lowercase unless they lead', () => {
    expect(titleCaseRole('director of engineering')).toBe('Director of Engineering');
    expect(titleCaseRole('the archivist')).toBe('The Archivist');
  });

  it('capitalizes across hyphens and trims', () => {
    expect(titleCaseRole('  front-end developer  ')).toBe('Front-End Developer');
  });

  it('passes through titles that start with a digit', () => {
    expect(titleCaseRole('3d artist')).toBe('3d Artist');
  });

  it('returns empty input unchanged', () => {
    expect(titleCaseRole('   ')).toBe('');
  });
});
