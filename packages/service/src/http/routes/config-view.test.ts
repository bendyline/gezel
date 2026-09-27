import { type GezelConfig, GezelConfigSchema } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  CONFIG_RESPONSE_HANDLER_KEYS,
  CONFIG_RESPONSE_OMITTED,
  configResponseFields,
} from './config-view.js';

describe('the /api/config response view', () => {
  const returned = new Set<string>([
    ...Object.keys(configResponseFields({} as GezelConfig)),
    ...CONFIG_RESPONSE_HANDLER_KEYS,
  ]);
  const schemaKeys = Object.keys(GezelConfigSchema.shape);

  it('places every config key deliberately: returned, or omitted with a reason', () => {
    const unplaced = schemaKeys.filter(
      (key) => !returned.has(key) && !(key in CONFIG_RESPONSE_OMITTED),
    );
    expect(unplaced).toEqual([]);
  });

  it('does not both return and omit a key, or omit one the schema lacks', () => {
    const omitted = Object.keys(CONFIG_RESPONSE_OMITTED);
    expect(omitted.filter((key) => returned.has(key))).toEqual([]);
    expect(omitted.filter((key) => !schemaKeys.includes(key))).toEqual([]);
  });

  // Settings rendered Balanced after every reload, and the next edit saved
  // `{mode: 'balanced', maxTokens}` over the stored Deep policy.
  it('reads back the settings that used to snap to their defaults', () => {
    const view = configResponseFields({
      retrieval: { mode: 'deep', maxTokens: 1_800 },
      autoRecall: { enabled: false },
      summarization: { enabled: false },
      generalistMode: 'on',
      promptDrafts: { keepSentDays: 30 },
      recognition: { mode: 'off' },
      localEngineReplicas: { 'qwen3.8-27b-q4': 2 },
      localEngineReplicasMax: 3,
      taskReferences: { enabled: false },
    } as GezelConfig);
    expect(view).toMatchObject({
      retrieval: { mode: 'deep', maxTokens: 1_800 },
      autoRecall: { enabled: false },
      summarization: { enabled: false },
      generalistMode: 'on',
      promptDrafts: { keepSentDays: 30 },
      recognition: { mode: 'off' },
      localEngineReplicas: { 'qwen3.8-27b-q4': 2 },
      localEngineReplicasMax: 3,
      taskReferences: { enabled: false },
    });
  });
});
