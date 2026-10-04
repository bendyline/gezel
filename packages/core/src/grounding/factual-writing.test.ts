import { describe, expect, it } from 'vitest';
import {
  factualLookupTools,
  factualWritingGuidance,
  isFactualRole,
  resolveFactualWriting,
} from './factual-writing.js';

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

  it('leads with Wikipedia when catalogs are off and with catalog search when selected', () => {
    const tools = ['search', 'read_document', 'wikipedia_read', 'wikipedia_search'];
    expect(factualLookupTools(tools, 'wikipedia')).toEqual([
      'wikipedia_search',
      'wikipedia_read',
      'search',
    ]);
    expect(factualLookupTools(tools, 'knowledge')).toEqual([
      'search',
      'wikipedia_search',
      'wikipedia_read',
    ]);
    const wikipedia = factualWritingGuidance({
      numbered: true,
      toolNames: tools,
      lookupPreference: 'wikipedia',
    });
    expect(wikipedia).toContain('No local knowledge catalog is in scope');
    expect(wikipedia).toContain('Start factual research with `wikipedia_search`');
    expect(wikipedia).toContain('Look it up first: `wikipedia_search`, `wikipedia_read`, `search`');
    const knowledge = factualWritingGuidance({
      numbered: true,
      toolNames: tools,
      lookupPreference: 'knowledge',
    });
    expect(knowledge).toContain('`search({ query, sources: ["knowledge"] })`');
  });

});
