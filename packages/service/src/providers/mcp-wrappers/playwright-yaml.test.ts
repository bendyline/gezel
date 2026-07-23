import { describe, expect, it } from 'vitest';
import {
  extractRefIndex,
  extractUrls,
  formatRefIndex,
  formatUrlList,
  stripNoise,
} from './playwright-yaml.js';

const SAMPLE = `- generic [ref=e2]:
  - banner [ref=e7]:
    - generic [ref=e8]:
      - generic [ref=e9]:
        - link "Skip to content" [ref=e10] [cursor=pointer]:
          - /url: "#site-content"
        - button "Search" [ref=e19] [cursor=pointer]:
          - generic [ref=e20]: Search
      - link "World News" [ref=e24] [cursor=pointer]:
        - /url: https://www.nytimes.com/section/world
      - link "World News" [ref=e25] [cursor=pointer]:
        - /url: https://www.nytimes.com/section/world
  - main [ref=e36]:
    - heading "World News" [level=1] [ref=e44]
    - textbox "Email" [ref=e60]
`;

describe('stripNoise', () => {
  it('removes [cursor=pointer] annotations', () => {
    const out = stripNoise(SAMPLE);
    expect(out).not.toContain('[cursor=pointer]');
    expect(out).toContain('"Skip to content" [ref=e10]');
  });

  it('leaves other bracket annotations alone', () => {
    const out = stripNoise(SAMPLE);
    expect(out).toContain('[level=1]');
    expect(out).toContain('[ref=e10]');
  });
});

describe('extractUrls', () => {
  it('pairs each /url: with its parent link/button text', () => {
    const urls = extractUrls(SAMPLE);
    expect(urls).toEqual(
      expect.arrayContaining([
        { text: 'Skip to content', url: '#site-content', ref: 'e10' },
        { text: 'World News', url: 'https://www.nytimes.com/section/world', ref: 'e24' },
      ]),
    );
  });

  it('dedupes by URL', () => {
    const urls = extractUrls(SAMPLE);
    const worldNews = urls.filter((u) => u.url.endsWith('/section/world'));
    expect(worldNews).toHaveLength(1);
  });

  it('returns empty for yaml without url lines', () => {
    expect(extractUrls('- generic [ref=e1]:\n  - heading "Hi" [ref=e2]')).toEqual([]);
  });
});

describe('extractRefIndex', () => {
  it('collects interactive elements with role/name/ref', () => {
    const refs = extractRefIndex(SAMPLE);
    expect(refs).toEqual(
      expect.arrayContaining([
        { role: 'link', name: 'Skip to content', ref: 'e10' },
        { role: 'button', name: 'Search', ref: 'e19' },
        { role: 'textbox', name: 'Email', ref: 'e60' },
      ]),
    );
  });

  it('excludes structural roles (generic, banner, main)', () => {
    const refs = extractRefIndex(SAMPLE);
    expect(refs.find((r) => r.role === 'generic')).toBeUndefined();
    expect(refs.find((r) => r.role === 'banner')).toBeUndefined();
    expect(refs.find((r) => r.role === 'main')).toBeUndefined();
  });

  it('excludes headings (read-only landmark, not actionable)', () => {
    const refs = extractRefIndex(SAMPLE);
    expect(refs.find((r) => r.role === 'heading')).toBeUndefined();
  });
});

describe('formatUrlList', () => {
  it('formats one bullet per URL with the ref bracket', () => {
    const out = formatUrlList([
      { text: 'Home', url: '/', ref: 'e1' },
      { text: 'About', url: '/about', ref: 'e2' },
    ]);
    expect(out).toBe('- "Home" → / [e1]\n- "About" → /about [e2]');
  });

  it('caps the list and notes the overflow', () => {
    const big = Array.from({ length: 100 }, (_, i) => ({
      text: `Link ${i}`,
      url: `/p/${i}`,
      ref: `e${i}`,
    }));
    const out = formatUrlList(big, 10);
    expect(out.split('\n')).toHaveLength(11);
    expect(out).toContain('… (90 more URLs');
  });

  it('returns empty string for empty input', () => {
    expect(formatUrlList([])).toBe('');
  });
});

describe('formatRefIndex', () => {
  it('formats role + ref + name per line', () => {
    const out = formatRefIndex([
      { role: 'button', name: 'Submit', ref: 'e1' },
      { role: 'link', name: 'Home', ref: 'e2' },
    ]);
    expect(out).toBe('- button [e1] "Submit"\n- link [e2] "Home"');
  });

  it('caps overflow', () => {
    const big = Array.from({ length: 80 }, (_, i) => ({
      role: 'button',
      name: `Btn ${i}`,
      ref: `e${i}`,
    }));
    const out = formatRefIndex(big, 5);
    expect(out.split('\n')).toHaveLength(6);
    expect(out).toContain('… (75 more');
  });
});
