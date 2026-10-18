import { type ChatSession, type SuggestWorkResult, rankWorkOptions } from '@bendyline/gezel';
import { lookupBehavior } from '@bendyline/gezel/local-loop';
import type { ResolvedModelProfile } from '@bendyline/gezel-inference/internal/model-profile/types';
import type { LLMSession } from '@bendyline/gezel-inference/internal/providers/types';
import { describe, expect, it } from 'vitest';
import type { Store } from '../fs/store.js';
import { resolveUserPromptPrelude } from './profile-hooks.js';

const store = { readConfig: async () => ({ meesterGezelId: 'meester' }) } as unknown as Store;

function state(behaviorIds: string[]) {
  const profile = {
    catalogId: 'gemma4-e4b-q4',
    tier: 'small',
    style: { family: 'gemma' },
    behaviors: behaviorIds.map((id) => ({ id, config: undefined, behavior: lookupBehavior(id)! })),
  } as unknown as ResolvedModelProfile;
  return {
    record: {
      id: 's1',
      gezelId: 'meester',
      projectId: 'default',
      model: 'gemma4-e4b-q4',
      providerName: 'llama-cpp',
    } as unknown as ChatSession,
    session: { getRegisteredToolNames: () => ['start_work', 'suggest_work'] } as unknown as LLMSession,
    profile,
  };
}

const options: SuggestWorkResult = rankWorkOptions({
  request: 'Plan a trip to Lisbon next spring for the four of us.',
  projectId: 'default',
  inDefault: true,
  workRequest: true,
  projectTypes: [
    { typeId: 'trip-planner', name: 'Trip planner' },
    { typeId: 'event-planner', name: 'Event planner' },
  ],
  selfTools: ['consult_researcher'],
});

const PRELUDE = ['tools.work-routing', 'prompt.work-options-prelude'];

async function prelude(extra: string[]): Promise<string> {
  const out = await resolveUserPromptPrelude(
    store,
    state([...PRELUDE, ...extra]),
    'Plan a trip to Lisbon next spring for the four of us.',
    'direct-user',
    [],
    options,
  );
  return out?.text ?? '';
}

describe('resolveUserPromptPrelude — work-options ablations', () => {
  it('lists every option with its id and the exit line by default', async () => {
    const text = await prelude([]);
    expect(text).toContain('[type:trip-planner]');
    expect(text).toContain('[type:event-planner]');
    expect(text).toContain('answer in chat yourself');
  });

  it('drops the guidance lines', async () => {
    const text = await prelude(['prompt.work-options-no-guidance']);
    expect(text).toContain('[type:event-planner]');
    expect(text).not.toContain('answer in chat yourself');
  });

  it('numbers the options instead of naming them', async () => {
    const text = await prelude(['prompt.work-options-ordinal']);
    expect(text).toContain('1. Trip planner');
    expect(text).not.toContain('[type:');
    expect(text).toContain('option: "<number>"');
  });

  it('offers only the best option, keeping the exit line', async () => {
    const text = await prelude(['prompt.work-options-top-one']);
    expect(text).toContain('[type:trip-planner]');
    expect(text).not.toContain('event-planner');
    expect(text).toContain('answer in chat yourself');
  });
});
