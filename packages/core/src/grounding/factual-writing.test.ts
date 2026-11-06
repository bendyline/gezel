import { describe, expect, it } from 'vitest';
import {
  asksForFiction,
  factualLookupTools,
  factualWritingGuidance,
  isEvidenceTool,
  isFactualRole,
  resolveFactualWriting,
} from './factual-writing.js';

describe('asksForFiction', () => {
  it('reads a request for a story or a poem as fiction', () => {
    for (const text of [
      'A story about ponies and unicorns',
      'Write me a short poem for my mom',
      'Can you write a bedtime story about dragons?',
      'Please tell us a funny story where the cat wins.',
      'Thanks! Now write a limerick about Mondays.',
      'A fictional diary of a lighthouse keeper',
      'Write a haiku.',
    ]) {
      expect(asksForFiction(text), text).toBe(true);
    }
  });

  it('leaves factual work with the same words alone', () => {
    for (const text of [
      'The story of the Roman Empire',
      'A report on short story sales in 2025',
      'Story points for the sprint',
      'Analyze the themes in Frost’s poems',
      'Summarize the non-fiction shortlist',
      'Write a biography of Ada Lovelace',
      '',
      undefined,
    ]) {
      expect(asksForFiction(text), String(text)).toBe(false);
    }
  });
});

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

  it('holds whoever works a grounded task to the rule, whatever their role', () => {
    expect(resolveFactualWriting({ role: 'Generalist', taskGrounded: true })).toEqual({
      on: true,
      reason: 'task',
    });
    expect(resolveFactualWriting({ override: false, taskGrounded: true }).on).toBe(false);
  });

  it('lets fiction work turn a writing role off, but not an explicit setting or contract', () => {
    expect(resolveFactualWriting({ role: 'Copywriter', fiction: true })).toEqual({
      on: false,
      reason: 'fiction',
    });
    expect(resolveFactualWriting({ override: true, role: 'Copywriter', fiction: true }).on).toBe(
      true,
    );
    expect(
      resolveFactualWriting({ role: 'Copywriter', fiction: true, taskGrounded: true }).on,
    ).toBe(true);
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

describe('isEvidenceTool', () => {
  it("counts gezel's own tools only from the fixed list", () => {
    expect(isEvidenceTool('read_file')).toBe(true);
    expect(isEvidenceTool('read_task_notes')).toBe(false);
    expect(isEvidenceTool('search_wikipedia')).toBe(false);
  });

  it("counts a third-party server's lookups by name, never its writes", () => {
    for (const tool of [
      'search_wikipedia',
      'read_wikipedia_sources',
      'brave_web_search',
      'get_page',
    ]) {
      expect(isEvidenceTool(tool, { thirdParty: true }), tool).toBe(true);
    }
    for (const tool of ['save_artifact', 'create_page', 'update_record', 'convert_document']) {
      expect(isEvidenceTool(tool, { thirdParty: true }), tool).toBe(false);
    }
  });
});
