import { describe, expect, it } from 'vitest';
import { parseYamlFrontmatter, parseYamlMapping, stringifyYamlFrontmatter } from './frontmatter.js';

describe('string-only YAML frontmatter codec', () => {
  it('leaves ordinary markdown untouched', () => {
    const source = '# Title\n\nBody\n';
    expect(parseYamlFrontmatter(source)).toEqual({ data: {}, content: source });
  });

  it('parses nested YAML without coercing timestamps or YAML 1.1 booleans', () => {
    const parsed = parseYamlFrontmatter(
      [
        '---',
        'name: Example',
        'releasedAt: 2026-07-29T12:34:56Z',
        'answer: yes',
        'nested:',
        '  enabled: true',
        '  tags: [one, two]',
        '---',
        '',
        '# Body',
      ].join('\n'),
    );
    expect(parsed.data).toEqual({
      name: 'Example',
      releasedAt: '2026-07-29T12:34:56Z',
      answer: 'yes',
      nested: { enabled: true, tags: ['one', 'two'] },
    });
    expect(parsed.content).toBe('\n# Body');
  });

  it('round-trips a mapping and body', () => {
    const data = {
      name: 'Researcher',
      triggers: ['find facts', 'cite sources'],
      config: { retries: 2 },
    };
    const serialized = stringifyYamlFrontmatter('Body\n', data);
    expect(parseYamlFrontmatter(serialized)).toEqual({ data, content: 'Body\n' });
  });

  it('accepts the YAML document-end marker as a closing fence', () => {
    expect(parseYamlFrontmatter('---\r\nname: CRLF\r\n...\r\nbody')).toEqual({
      data: { name: 'CRLF' },
      content: 'body',
    });
  });

  it('rejects malformed, duplicate-key, non-mapping, and unclosed YAML', () => {
    expect(() => parseYamlFrontmatter('---\nname: [broken\n---\n')).toThrow();
    expect(() => parseYamlFrontmatter('---\nname: one\nname: two\n---\n')).toThrow();
    expect(() => parseYamlFrontmatter('---\n- one\n- two\n---\n')).toThrow(/mapping/);
    expect(() => parseYamlFrontmatter('---\nname: never closed\n')).toThrow(/closing delimiter/);
    expect(() => parseYamlMapping('[one, two]')).toThrow(/mapping/);
  });
});
