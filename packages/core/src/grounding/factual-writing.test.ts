import { describe, expect, it } from 'vitest';
import { factualWritingGuidance, isFactualRole, resolveFactualWriting } from './factual-writing.js';

describe('isFactualRole', () => {
  it('holds writers, researchers and reviewers to the citation rule', () => {
    for (const role of [
      'Researcher',
      'Copywriter',
      'Reviewer',
      'Writer',
      'Technical Writer',
      'Journalist',
      'Editor',
      'Historian',
      'Genealogist',
      'Fact Checker',
      'Research Analyst',
      'Boekwachter',
      'Archivaris',
      'Verhalenverteller',
    ]) {
      expect(isFactualRole(role), role).toBe(true);
    }
  });

  it('leaves fiction and unrelated crafts alone', () => {
    for (const role of [
      'Schrijfmaat',
      'Novelist',
      'Fiction Writer',
      'Poet',
      'Screenwriter',
      'Developer',
      'Designer',
      'Meester',
      'Voorman',
      '',
      undefined,
    ]) {
      expect(isFactualRole(role), String(role)).toBe(false);
    }
  });
});

describe('resolveFactualWriting', () => {
  it('lets an explicit choice win over the role', () => {
    expect(resolveFactualWriting({ override: false, role: 'Researcher' })).toEqual({
      on: false,
      reason: 'off',
    });
    expect(resolveFactualWriting({ override: true, role: 'Developer' })).toEqual({
      on: true,
      reason: 'override',
    });
  });

  it('turns on for any session that can write into a document', () => {
    expect(
      resolveFactualWriting({ role: 'Meester', toolNames: ['list_gezels', 'doc_insert_text'] }),
    ).toEqual({ on: true, reason: 'document' });
    expect(resolveFactualWriting({ role: 'Meester', toolNames: ['list_gezels'] })).toEqual({
      on: false,
      reason: 'off',
    });
  });
});

describe('factualWritingGuidance', () => {
  it('names only the lookup tools the session has, and the document rule only when it writes documents', () => {
    const text = factualWritingGuidance({
      numbered: true,
      toolNames: ['wikipedia_search', 'search', 'doc_insert_text'],
    });
    expect(text).toContain('`search`, `wikipedia_search`');
    expect(text).not.toContain('web_search');
    expect(text).toContain('removes the markers');
    expect(text).toContain('In a file you write, name the source itself');
    const bare = factualWritingGuidance({ numbered: false, toolNames: [] });
    expect(bare).toContain('Ask the person for a source');
    expect(bare).not.toContain('[1]');
  });
});
