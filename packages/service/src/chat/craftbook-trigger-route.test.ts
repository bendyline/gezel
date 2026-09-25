import type { CatalogItemSummary } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  matchCraftbookTrigger,
  triggerCandidateIsLaunchable,
  triggerCandidatesFromListing,
  triggerPhrasePlan,
} from './craftbook-trigger-route.js';

const minutes = {
  id: 'meeting-minutes',
  name: 'Meeting Minutes',
  triggers: ['meeting minutes', 'write up meeting notes', 'action items list'],
  paramSchema: { properties: { workPath: { type: 'string', default: '.' } } },
};
const social = {
  id: 'draft-social-post',
  name: 'Draft a Social Post',
  triggers: ['draft a social post', 'draft a post about', 'draft a tweet'],
  paramSchema: { properties: { topic: { type: 'string' }, campaign: { type: 'string' } } },
};
const changelog = { id: 'changelog', name: 'Changelog', triggers: ['changelog', 'log'] };

describe('matchCraftbookTrigger', () => {
  it('matches on word boundaries, case-insensitively, and prefers the longest trigger', () => {
    expect(
      matchCraftbookTrigger('Can you write up Meeting Notes from today?', [minutes, social]),
    ).toEqual({ candidate: minutes, trigger: 'write up meeting notes' });
    expect(
      matchCraftbookTrigger('please draft a post about our launch', [minutes, social]),
    ).toEqual({
      candidate: social,
      trigger: 'draft a post about',
    });
    expect(matchCraftbookTrigger('I keep change logging everything', [changelog])).toBeNull();
    expect(matchCraftbookTrigger('update the changelog for 1.2', [changelog])?.trigger).toBe(
      'changelog',
    );
  });

  it('ignores triggers too short to mean anything', () => {
    expect(matchCraftbookTrigger('the log is noisy', [changelog])).toBeNull();
  });
});

describe('triggerCandidateIsLaunchable', () => {
  it('needs installed toolsets, no file input, and every required param covered', () => {
    expect(triggerCandidateIsLaunchable(undefined)).toBe(true);
    expect(triggerCandidateIsLaunchable(social.paramSchema)).toBe(true);
    expect(
      triggerCandidateIsLaunchable({
        required: ['topic', 'workPath'],
        properties: { topic: { type: 'string' }, workPath: { type: 'string', default: '.' } },
      }),
    ).toBe(true);
    expect(
      triggerCandidateIsLaunchable({
        required: ['audience'],
        properties: { topic: { type: 'string' }, audience: { type: 'string' } },
      }),
    ).toBe(false);
    expect(
      triggerCandidateIsLaunchable({
        required: ['source'],
        properties: { source: { type: 'string', input: { kind: 'folder' } } },
      }),
    ).toBe(false);
  });

  it('narrows a listing by triggers, setup, and launchability', () => {
    const items = [
      {
        sourceId: 'bundled',
        kind: 'craftbook-template',
        manifest: { kind: 'craftbook-template', ...minutes },
      },
      {
        sourceId: 'bundled',
        kind: 'craftbook-template',
        manifest: { kind: 'craftbook-template', ...social },
      },
      {
        sourceId: 'bundled',
        kind: 'craftbook-template',
        manifest: { kind: 'craftbook-template', id: 'silent', name: 'Silent', triggers: [] },
      },
    ] as unknown as CatalogItemSummary[];
    const candidates = triggerCandidatesFromListing(items, {
      'draft-social-post': [{ toolsetId: 'bluesky' }],
    });
    expect(candidates.map((candidate) => candidate.id)).toEqual(['meeting-minutes']);
  });
});

describe('triggerPhrasePlan', () => {
  it('proposes the book with the subject in its main content param, at medium confidence', () => {
    const plan = triggerPhrasePlan('Could you draft a post about the spring release?', [social]);
    expect(plan).toMatchObject({
      route: 'craftbook',
      confidence: 'medium',
      reason: 'trigger-phrase',
      visible: true,
      display: { label: 'Planned: Draft a Social Post', badges: ['Craftbook'] },
      craftbook: {
        id: 'draft-social-post',
        invocation: {
          description: 'Could you draft a post about the spring release?',
          params: { topic: 'the spring release' },
        },
      },
      requiredTools: [],
    });
    expect(plan?.output).toBeUndefined();
  });

  it('stays quiet for questions and for work already under way', () => {
    expect(triggerPhrasePlan('How do I write meeting minutes?', [minutes])).toBeNull();
    expect(triggerPhrasePlan('cancel the meeting minutes task', [minutes])).toBeNull();
    expect(triggerPhrasePlan('Tell me a joke', [minutes, social])).toBeNull();
  });
});
