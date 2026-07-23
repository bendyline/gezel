import { describe, expect, it, vi } from 'vitest';
import { PlaywrightArgValidator } from './playwright-arg-validator.js';
import type { McpToolWrapperContext } from './types.js';

function ctx(): McpToolWrapperContext {
  return {
    spec: { command: 'npx', args: ['@playwright/mcp@latest'], env: {} },
    cwd: '/tmp',
    modelTier: 'large',
    isMeester: false,
    hasTool: () => true,
    callTool: vi.fn(async () => ({ text: '', images: [] })),
  };
}

describe('PlaywrightArgValidator', () => {
  it('matches @playwright/mcp servers', () => {
    expect(
      PlaywrightArgValidator.matches({
        command: 'npx',
        args: ['@playwright/mcp@latest'],
        env: {},
      }),
    ).toBe(true);
  });

  it('allows browser_navigate with a real https URL', async () => {
    const v = await PlaywrightArgValidator.preProcess!(
      'browser_navigate',
      { url: 'https://news.ycombinator.com' },
      ctx(),
    );
    expect(v.kind).toBe('allow');
  });

  it('allows http URLs (localhost, intranet)', async () => {
    const v = await PlaywrightArgValidator.preProcess!(
      'browser_navigate',
      { url: 'http://localhost:3000/page' },
      ctx(),
    );
    expect(v.kind).toBe('allow');
  });

  it('allows about:blank and similar URI schemes', async () => {
    const v = await PlaywrightArgValidator.preProcess!(
      'browser_navigate',
      { url: 'about:blank' },
      ctx(),
    );
    expect(v.kind).toBe('allow');
  });

  it('rejects a search-query-shaped URL with a teaching error', async () => {
    const v = await PlaywrightArgValidator.preProcess!(
      'browser_navigate',
      { url: 'world news' },
      ctx(),
    );
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') {
      expect(v.error).toContain("'world news'");
      expect(v.error).toContain('https://');
      expect(v.error).toContain('not a URL');
    }
  });

  it('rejects a domain-without-scheme', async () => {
    const v = await PlaywrightArgValidator.preProcess!(
      'browser_navigate',
      { url: 'nytimes.com' },
      ctx(),
    );
    expect(v.kind).toBe('reject');
  });

  it('rejects an empty url', async () => {
    const v = await PlaywrightArgValidator.preProcess!('browser_navigate', { url: '' }, ctx());
    expect(v.kind).toBe('reject');
  });

  it('passes through tools other than browser_navigate', async () => {
    const v = await PlaywrightArgValidator.preProcess!(
      'browser_click',
      { ref: 'e10', element: 'Search button' },
      ctx(),
    );
    expect(v.kind).toBe('allow');
  });

  it('passes through when url is missing or non-string', async () => {
    const a = await PlaywrightArgValidator.preProcess!('browser_navigate', {}, ctx());
    const b = await PlaywrightArgValidator.preProcess!(
      'browser_navigate',
      { url: 42 as unknown as string },
      ctx(),
    );
    expect(a.kind).toBe('allow');
    expect(b.kind).toBe('allow');
  });
});
