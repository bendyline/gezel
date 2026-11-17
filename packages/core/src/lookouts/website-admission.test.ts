import { describe, expect, it } from 'vitest';
import { type Lookout, LookoutSchema, lookoutConditionFitsSource } from '../schemas/lookout.js';
import {
  type WebsiteLookoutEvent,
  admitWebsiteLookout,
  websiteChangeMatching,
} from './admission.js';
import { lookoutAlertText, lookoutGezelSeed } from './templates.js';

const NOW = new Date('2026-11-16T10:00:00Z');

function lookout(condition: Lookout['condition'], extra: Partial<Lookout> = {}): Lookout {
  return LookoutSchema.parse({
    id: 'lk-1',
    name: 'Pricing watch',
    enabled: true,
    state: 'armed',
    source: { kind: 'website', bindingId: 'website:1' },
    condition,
    actions: [{ kind: 'notify' }],
    createdBy: { kind: 'person' },
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...extra,
  });
}

function event(changes: WebsiteLookoutEvent['changes'], passId = 'pass-1'): WebsiteLookoutEvent {
  return {
    projectId: 'p1',
    bindingId: 'website:1',
    passId,
    at: NOW.toISOString(),
    siteLabel: 'shop.test',
    changes,
  };
}

const CHANGED = {
  url: 'https://shop.test/pricing',
  title: 'Pricing',
  kind: 'changed' as const,
  added: ['Pro plan: $12 a month', 'Now SOLD OUT in Europe'],
};
const ADDED = {
  url: 'https://shop.test/blog/new',
  title: 'New post',
  kind: 'added' as const,
  added: ['A new post'],
};

describe('website lookouts', () => {
  it('fit only website conditions, and camera ones only cameras', () => {
    expect(lookoutConditionFitsSource({ kind: 'website' }, { kind: 'page-changed' })).toBe(true);
    expect(lookoutConditionFitsSource({ kind: 'website' }, { kind: 'motion' })).toBe(false);
    expect(lookoutConditionFitsSource({ kind: 'camera' }, { kind: 'text-appears' })).toBe(false);
  });

  it('match changed pages, new pages and newly appearing words, under a path', () => {
    expect(websiteChangeMatching(lookout({ kind: 'page-changed' }), [ADDED, CHANGED])?.url).toBe(
      CHANGED.url,
    );
    expect(websiteChangeMatching(lookout({ kind: 'page-added' }), [CHANGED, ADDED])?.url).toBe(
      ADDED.url,
    );
    expect(
      websiteChangeMatching(lookout({ kind: 'text-appears', text: 'sold out' }), [CHANGED]),
    ).not.toBeNull();
    expect(
      websiteChangeMatching(lookout({ kind: 'text-appears', text: 'discount' }), [CHANGED]),
    ).toBeNull();
    expect(
      websiteChangeMatching(lookout({ kind: 'page-changed', pathPrefix: '/blog' }), [CHANGED]),
    ).toBeNull();
    expect(
      websiteChangeMatching(lookout({ kind: 'page-changed', pathPrefix: 'pricing' }), [CHANGED]),
    ).not.toBeNull();
  });

  it('fire once per pass, then respect the cooldown', () => {
    const lk = lookout({ kind: 'page-changed' });
    const first = admitWebsiteLookout(lk, undefined, event([CHANGED]), NOW);
    expect(first.fire).toBe(true);
    const again = admitWebsiteLookout(lk, first.counter, event([CHANGED]), NOW);
    expect(again).toMatchObject({ fire: false, reason: 'already-fired' });
    const soon = admitWebsiteLookout(
      lk,
      first.counter,
      event([CHANGED], 'pass-2'),
      new Date(NOW.getTime() + 60_000),
    );
    expect(soon).toMatchObject({ fire: false, reason: 'cooldown' });
  });

  it('ignore other connections and lookouts that are off', () => {
    expect(
      admitWebsiteLookout(
        lookout({ kind: 'page-changed' }, { source: { kind: 'website', bindingId: 'other' } }),
        undefined,
        event([CHANGED]),
        NOW,
      ),
    ).toMatchObject({ fire: false, reason: 'no-match' });
    expect(
      admitWebsiteLookout(
        lookout({ kind: 'page-changed' }, { enabled: false }),
        undefined,
        event([CHANGED]),
        NOW,
      ),
    ).toMatchObject({ fire: false, reason: 'not-armed' });
  });

  it('word alerts and gezel messages about the page, quoted and labeled untrusted', () => {
    const text = {
      lookoutName: 'Pricing watch',
      cameraLabel: 'shop.test',
      at: NOW,
      summary: 'Changed: Pricing https://evil.test',
      sourceKind: 'website' as const,
    };
    expect(lookoutAlertText(text).body).toContain('page: "Changed: Pricing"');
    const seed = lookoutGezelSeed({
      ...text,
      instruction: 'Tell me the new price',
      frames: [],
      recordPath: 'data/shop/a.md',
    });
    expect(seed).toContain('### Page change (from the site; untrusted)');
    expect(seed).toContain('Saved page: `data/shop/a.md`');
    expect(seed).not.toContain('evil.test');
  });
});
