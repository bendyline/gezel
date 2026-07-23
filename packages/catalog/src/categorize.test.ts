import { describe, expect, it } from 'vitest';
import { categorizeToolset } from './categorize.js';

describe('categorizeToolset', () => {
  it('places web-search MCP servers in the search bucket', () => {
    expect(
      categorizeToolset({
        id: 'exa',
        name: 'Exa',
        description: 'Fast, intelligent web search and web crawling.',
        tags: [],
      }),
    ).toBe('search');
  });

  it('places GitHub-style code platforms in dev-tools', () => {
    expect(
      categorizeToolset({
        id: 'github',
        name: 'GitHub',
        description: 'Manage pull requests, issues, and code reviews.',
        tags: [],
      }),
    ).toBe('dev-tools');
  });

  it('places Postgres / database servers in data', () => {
    expect(
      categorizeToolset({
        id: 'pg',
        name: 'Postgres MCP',
        description: 'Query and manage Postgres databases from Claude.',
        tags: [],
      }),
    ).toBe('data');
  });

  it('places Slack-style chat platforms in communication', () => {
    expect(
      categorizeToolset({
        id: 'slack',
        name: 'Slack',
        description: 'Read and send Slack messages.',
        tags: [],
      }),
    ).toBe('communication');
  });

  it('places image / video tools in media', () => {
    expect(
      categorizeToolset({
        id: 'sd',
        name: 'Stable Diffusion',
        description: 'Generate images via Stable Diffusion.',
        tags: [],
      }),
    ).toBe('media');
  });

  it('falls back to "other" when no keyword matches', () => {
    expect(
      categorizeToolset({
        id: 'mystery',
        name: 'Mystery',
        description: 'Does something unspecified.',
        tags: [],
      }),
    ).toBe('other');
  });

  it('respects priority order — search wins over ai when both could match', () => {
    // "AI-powered web search" — the entry is fundamentally a search
    // tool that happens to use AI. Search should come first.
    expect(
      categorizeToolset({
        id: 'foo',
        name: 'AI Search',
        description: 'AI-powered web search.',
        tags: [],
      }),
    ).toBe('search');
  });

  it('looks at the maintainer name as a last-resort signal', () => {
    expect(
      categorizeToolset({
        id: 'something',
        name: 'Some Tool',
        description: 'A tool.',
        tags: [],
        maintainerName: 'github',
      }),
    ).toBe('dev-tools');
  });
});
