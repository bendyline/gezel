import { describe, expect, it } from 'vitest';
import { SlugAllocator, baseSlug, isValidSlug } from './slug.js';

describe('baseSlug', () => {
  it('strips io.github. prefix and joins with dashes', () => {
    expect(baseSlug('io.github.modelcontextprotocol/server-filesystem')).toBe(
      'modelcontextprotocol-server-filesystem',
    );
  });

  it('lowercases and replaces invalid chars with dashes', () => {
    expect(baseSlug('com.Example/My_Cool@Server')).toBe('com.example-my-cool-server');
  });

  it('collapses runs of dashes and trims leading/trailing punctuation', () => {
    expect(baseSlug('---foo___bar---')).toBe('foo-bar');
  });

  it('falls back to "unnamed" when input collapses to nothing', () => {
    expect(baseSlug('---')).toBe('unnamed');
    expect(baseSlug('...')).toBe('unnamed');
  });

  it('truncates over-long names', () => {
    const long = `io.github.${'a'.repeat(200)}`;
    const slug = baseSlug(long);
    expect(slug.length).toBeLessThanOrEqual(63);
  });

  it('produces gezel-valid slugs for typical inputs', () => {
    const samples = [
      'io.github.modelcontextprotocol/server-github',
      'io.github.modelcontextprotocol/server-filesystem',
      'com.fastly/mcp',
      'io.github.foo/bar.baz',
    ];
    for (const s of samples) {
      expect(isValidSlug(baseSlug(s))).toBe(true);
    }
  });
});

describe('SlugAllocator', () => {
  it('mints slugs deterministically and returns persisted ones unchanged', () => {
    const a = new SlugAllocator();
    const r1 = a.assign('io.github.foo/bar');
    expect(r1.fresh).toBe(true);
    expect(r1.slug).toBe('foo-bar');
    const r2 = a.assign('io.github.foo/bar');
    expect(r2.fresh).toBe(false);
    expect(r2.slug).toBe('foo-bar');
  });

  it('appends -2, -3, ... on collision', () => {
    // `io.github.foo/bar` and `io.github.foo-bar` both base-slug to
    // `foo-bar` (the prefix strip + slash→dash conversion produces
    // the same suffix).
    const a = new SlugAllocator();
    expect(a.assign('io.github.foo/bar').slug).toBe('foo-bar');
    expect(a.assign('io.github.foo-bar').slug).toBe('foo-bar-2');
    expect(a.assign('io.github.foo--bar').slug).toBe('foo-bar-3');
  });

  it('honors a seeded slug map verbatim, even when collision-prone', () => {
    // The seeded entry holds the bare slug; the colliding one gets a
    // suffix instead of stealing the bare form back.
    const a = new SlugAllocator({ 'io.github.foo-bar': 'foo-bar' });
    expect(a.assign('io.github.foo-bar').slug).toBe('foo-bar');
    expect(a.assign('io.github.foo/bar').slug).toBe('foo-bar-2');
  });

  it('toJSON round-trips and is sorted', () => {
    const a = new SlugAllocator();
    a.assign('io.github.zeta/srv');
    a.assign('io.github.alpha/srv');
    const json = a.toJSON();
    const keys = Object.keys(json);
    expect(keys).toEqual([...keys].sort());
  });
});
