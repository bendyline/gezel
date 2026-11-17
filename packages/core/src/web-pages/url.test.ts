import { describe, expect, it } from 'vitest';
import {
  findUrlsInText,
  linkRefusal,
  normalizePageUrl,
  redactPageUrl,
  scopeOfUrl,
  siteScopeFor,
} from './url.js';

describe('normalizePageUrl', () => {
  it('drops the fragment and tracking parameters and sorts the rest', () => {
    expect(normalizePageUrl('https://Example.com/a?utm_source=x&b=2&a=1#top')).toBe(
      'https://example.com/a?a=1&b=2',
    );
    expect(normalizePageUrl('https://example.com')).toBe('https://example.com/');
  });

  it('refuses what is not an http(s) page, and addresses with credentials', () => {
    expect(normalizePageUrl('javascript:alert(1)')).toBeNull();
    expect(normalizePageUrl('file:///etc/passwd')).toBeNull();
    expect(normalizePageUrl('https://me:pw@example.com/')).toBeNull();
    expect(normalizePageUrl('not a url')).toBeNull();
  });

  it('resolves relative links against a base', () => {
    expect(normalizePageUrl('../b', 'https://example.com/docs/a/x')).toBe(
      'https://example.com/docs/b',
    );
  });
});

describe('site scopes', () => {
  it('takes the folder of the start address', () => {
    expect(siteScopeFor('https://site.test/docs/intro')?.pathPrefix).toBe('/docs/');
    expect(siteScopeFor('https://site.test/docs/')?.pathPrefix).toBe('/docs/');
    expect(siteScopeFor('https://site.test')?.pathPrefix).toBe('/');
  });

  it('keeps links inside the site and folder, ignoring www', () => {
    const scopes = [siteScopeFor('https://www.site.test/docs/')!];
    expect(scopeOfUrl('https://site.test/docs/a', scopes)).not.toBeNull();
    expect(scopeOfUrl('https://site.test/docs', scopes)).not.toBeNull();
    expect(scopeOfUrl('https://site.test/blog/a', scopes)).toBeNull();
    expect(scopeOfUrl('https://other.test/docs/a', scopes)).toBeNull();
    expect(scopeOfUrl('https://site.test:8443/docs/a', scopes)).toBeNull();
  });

  it('lets an http site upgrade to https but never the reverse', () => {
    expect(scopeOfUrl('https://site.test/a', [siteScopeFor('http://site.test/')!])).not.toBeNull();
    expect(scopeOfUrl('http://site.test/a', [siteScopeFor('https://site.test/')!])).toBeNull();
  });
});

describe('linkRefusal', () => {
  it('never follows sign-out, cart or editor links, nor files', () => {
    expect(linkRefusal('https://s.test/logout')).toBe('action');
    expect(linkRefusal('https://s.test/account/sign-out')).toBe('action');
    expect(linkRefusal('https://s.test/cart')).toBe('action');
    expect(linkRefusal('https://s.test/wiki/Page?action=edit')).toBe('action');
    expect(linkRefusal('https://s.test/report.pdf')).toBe('not-a-page');
    expect(linkRefusal('https://s.test/login')).toBe('account');
  });

  it('never follows a link carrying a credential-like parameter', () => {
    expect(linkRefusal('https://s.test/unsubscribe-later?token=abc')).toBe('secret');
    expect(linkRefusal('https://s.test/page?sig=abc')).toBe('secret');
  });

  it('follows ordinary pages anonymously, and is stricter signed in', () => {
    expect(linkRefusal('https://s.test/archive/2024')).toBeNull();
    expect(linkRefusal('https://s.test/report-2024')).toBeNull();
    expect(linkRefusal('https://s.test/items/7/delete')).toBeNull();
    expect(linkRefusal('https://s.test/items/7/delete', { signedIn: true })).toBe('action');
    expect(linkRefusal('https://s.test/settings?mode=disable', { signedIn: true })).toBe('action');
  });

  it('applies the person’s exclude patterns', () => {
    expect(linkRefusal('https://s.test/blog/a', { exclude: ['/blog/'] })).toBe('excluded');
    expect(linkRefusal('https://s.test/docs/a?page=2', { exclude: ['?page='] })).toBe('excluded');
    expect(linkRefusal('https://s.test/tag/x', { exclude: ['/tag/*'] })).toBe('excluded');
    expect(linkRefusal('https://s.test/docs/a', { exclude: ['/blog/'] })).toBeNull();
  });
});

describe('redactPageUrl', () => {
  it('hides credentials and secret parameter values', () => {
    expect(redactPageUrl('https://u:p@s.test/a?token=abc&q=1#x')).toBe(
      'https://s.test/a?token=%E2%80%A6&q=1',
    );
    expect(redactPageUrl('nope')).toBe('(address)');
  });
});

describe('findUrlsInText', () => {
  it('finds addresses in a message, trims punctuation and keeps balanced parentheses', () => {
    expect(
      findUrlsInText(
        'Read https://example.com/docs/intro. Also (see https://en.wikipedia.org/wiki/Guild_(organization)) and www.python.org!',
      ),
    ).toEqual([
      'https://example.com/docs/intro',
      'https://en.wikipedia.org/wiki/Guild_(organization)',
      'https://www.python.org/',
    ]);
  });

  it('ignores hosts with no dot and duplicates', () => {
    expect(findUrlsInText('http://intranet/x https://a.test/ https://a.test/#frag')).toEqual([
      'https://a.test/',
    ]);
  });
});
