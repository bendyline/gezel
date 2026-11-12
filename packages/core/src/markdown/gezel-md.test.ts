import { describe, expect, it } from 'vitest';
import { parseGezelMarkdown, serializeGezelMarkdown } from './gezel-md.js';

describe('parseGezelMarkdown', () => {
  it('parses frontmatter and template-annotated sections', () => {
    const md = [
      '---',
      'name: Researcher',
      'model: gpt-4o',
      'temperature: 0.2',
      '---',
      '',
      '## System {[instruction]}',
      '',
      'You are a helpful researcher.',
      '',
      '## Memory {[memory scope=long]}',
      '',
      '- remembers things',
      '',
    ].join('\n');

    const parsed = parseGezelMarkdown(md);
    expect(parsed.frontmatter.name).toBe('Researcher');
    expect(parsed.frontmatter.model).toBe('gpt-4o');
    expect(parsed.sections).toHaveLength(2);
    expect(parsed.sections[0]?.template).toBe('instruction');
    expect(parsed.sections[0]?.heading).toBe('System');
    expect(parsed.sections[1]?.template).toBe('memory');
    expect(parsed.sections[1]?.params).toEqual({ scope: 'long' });
  });

  it('round-trips through serialize', () => {
    const md = [
      '---',
      'name: Researcher',
      '---',
      '',
      '## System {[instruction]}',
      '',
      'Body here.',
      '',
    ].join('\n');
    const parsed = parseGezelMarkdown(md);
    const serialized = serializeGezelMarkdown(parsed);
    const reparsed = parseGezelMarkdown(serialized);
    expect(reparsed.frontmatter.name).toBe('Researcher');
    expect(reparsed.sections[0]?.template).toBe('instruction');
    expect(reparsed.sections[0]?.body).toContain('Body here.');
  });

  it('keeps an opening H1 stable from the first round trip', () => {
    const md = [
      '---',
      'name: Ada',
      '---',
      '',
      '# Ada',
      '',
      'A careful engineer.',
      '',
      '## Working style',
      '',
      'Small steps.',
      '',
    ].join('\n');
    const parsed = parseGezelMarkdown(md);
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0]).toMatchObject({ heading: 'Ada', level: 1 });

    const once = serializeGezelMarkdown(parsed);
    expect(once).toContain('# Ada\n');
    expect(once).not.toContain('## Ada');
    const reparsed = parseGezelMarkdown(once);
    expect(reparsed.sections).toEqual(parsed.sections);
    expect(serializeGezelMarkdown(reparsed)).toBe(once);
  });

  it('keeps a body that is only an H1 at level 1', () => {
    const parsed = parseGezelMarkdown('---\nname: Ada\n---\n\n# Ada\n');
    const once = serializeGezelMarkdown(parsed);
    expect(once).toContain('# Ada\n');
    expect(once).not.toContain('## Ada');
    expect(serializeGezelMarkdown(parseGezelMarkdown(once))).toBe(once);
  });

  it('leaves the default level off ## sections', () => {
    const parsed = parseGezelMarkdown('---\nname: Ada\n---\n\n## About\n\nBody.\n');
    expect(parsed.sections[0]).toEqual({ heading: 'About', body: 'Body.' });
  });

  it('handles markdown with no headings', () => {
    const parsed = parseGezelMarkdown('---\nname: Simple\n---\n\njust a body');
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0]?.heading).toBe('');
    expect(parsed.sections[0]?.body).toBe('just a body');
  });

  it('round-trips the optional font field', () => {
    const md = ['---', 'name: Stylist', 'font: pt-serif', '---', '', 'body'].join('\n');
    const parsed = parseGezelMarkdown(md);
    expect(parsed.frontmatter.font).toBe('pt-serif');
    const reparsed = parseGezelMarkdown(serializeGezelMarkdown(parsed));
    expect(reparsed.frontmatter.font).toBe('pt-serif');
  });

  it('round-trips the traits array', () => {
    const md = ['---', 'name: Grower', '---', '', 'body'].join('\n');
    const parsed = parseGezelMarkdown(md);
    parsed.frontmatter.traits = [
      {
        id: 'trait-abc123',
        text: 'Write failing tests before touching implementation code.',
        adoptedAt: '2026-06-11T00:00:00Z',
        source: 'levelup',
      },
      { id: 'trait-def456', text: 'Keep PRs under 300 lines.', adoptedAt: '2026-06-12T00:00:00Z' },
    ];
    const reparsed = parseGezelMarkdown(serializeGezelMarkdown(parsed));
    expect(reparsed.frontmatter.traits).toEqual(parsed.frontmatter.traits);
  });
});
