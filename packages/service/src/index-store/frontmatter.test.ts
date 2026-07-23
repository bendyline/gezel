import { describe, expect, it } from 'vitest';
import { parseFrontmatter, withFrontmatter } from './frontmatter.js';

describe('parseFrontmatter', () => {
  it('extracts a frontmatter block and returns the body', () => {
    const { data, body } = parseFrontmatter(
      '---\nfrom: alice@example.com\nsubject: "Hi there"\n---\n\nthe body text\n',
    );
    expect(data).toEqual({ from: 'alice@example.com', subject: 'Hi there' });
    expect(body.trim()).toBe('the body text');
  });

  it('returns the whole content as body when there is no frontmatter', () => {
    const { data, body } = parseFrontmatter('# Just markdown\n');
    expect(data).toEqual({});
    expect(body).toBe('# Just markdown\n');
  });

  it('round-trips with withFrontmatter', () => {
    const md = withFrontmatter({ from: 'a@b.com', subject: 'Re: x' }, 'body');
    const { data } = parseFrontmatter(md);
    expect(data.from).toBe('a@b.com');
    expect(data.subject).toBe('Re: x');
  });
});
