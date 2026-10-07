import { describe, expect, it } from 'vitest';
import {
  type CraftbookSetupState,
  craftbookSetupGaps,
  resolveCraftbookModelNeeds,
} from './craftbook-setup.js';

const READY: CraftbookSetupState = {
  allowExternalServices: true,
  webSearchProvider: 'brave',
  hasBraveSearchApiKey: true,
  installedModels: { 'llama-cpp': ['qwen3.8-27b-q4', 'gemma4-31b-q4'] },
};

const paramSchema = {
  type: 'object',
  properties: {
    writerModel: { type: 'string', default: 'qwen3.8-27b-q4' },
    checkerModel: { type: 'string', default: 'gemma4-31b-q4' },
    secondCheckerModel: { type: 'string' },
    provider: { type: 'string', default: 'llama-cpp' },
  },
};

const qualla = [
  { id: '{{writerModel}}', provider: '{{provider}}', reason: 'Writes the stories' },
  { id: '{{checkerModel}}', provider: '{{provider}}', reason: 'Checks every sentence' },
  { id: '{{secondCheckerModel}}', provider: '{{provider}}' },
];

describe('resolveCraftbookModelNeeds', () => {
  it('resolves param references from the paramSchema defaults', () => {
    expect(resolveCraftbookModelNeeds(qualla, { paramSchema, defaultProvider: 'mlx' })).toEqual([
      { id: 'qwen3.8-27b-q4', provider: 'llama-cpp', reasons: ['Writes the stories'] },
      { id: 'gemma4-31b-q4', provider: 'llama-cpp', reasons: ['Checks every sentence'] },
    ]);
  });

  it('follows a run that picks another model, and merges the duplicate', () => {
    const needs = resolveCraftbookModelNeeds(qualla, {
      params: { writerModel: 'gemma4-31b-q4' },
      paramSchema,
      defaultProvider: 'mlx',
    });
    expect(needs).toEqual([
      {
        id: 'gemma4-31b-q4',
        provider: 'llama-cpp',
        reasons: ['Writes the stories', 'Checks every sentence'],
      },
    ]);
  });

  it('keeps an optional model only when the run names it', () => {
    const needs = resolveCraftbookModelNeeds(qualla, {
      params: { secondCheckerModel: 'glm-5.2-q4' },
      paramSchema,
      defaultProvider: 'mlx',
    });
    expect(needs.map((need) => need.id)).toContain('glm-5.2-q4');
  });

  it("uses this computer's engine when none is named, and skips hosted providers", () => {
    expect(
      resolveCraftbookModelNeeds([{ id: 'qwen3.8-27b-q4' }], { defaultProvider: 'mlx' }),
    ).toEqual([{ id: 'qwen3.8-27b-q4', provider: 'mlx', reasons: [] }]);
    expect(
      resolveCraftbookModelNeeds(qualla, {
        params: { provider: 'anthropic' },
        paramSchema,
        defaultProvider: 'llama-cpp',
      }),
    ).toEqual([]);
  });
});

describe('craftbookSetupGaps', () => {
  const models = resolveCraftbookModelNeeds(qualla, { paramSchema, defaultProvider: 'mlx' });
  const services = [{ kind: 'web-search' as const, reason: 'Research checks facts' }];

  it('is empty when everything is in place', () => {
    expect(craftbookSetupGaps({ services, models }, READY)).toEqual([]);
  });

  it('lists External services, web search, then downloads, on a fresh Lockdown install', () => {
    const gaps = craftbookSetupGaps(
      { services, models },
      { allowExternalServices: false, hasBraveSearchApiKey: false, installedModels: {} },
    );
    expect(gaps.map((gap) => gap.kind)).toEqual([
      'external-services',
      'web-search',
      'model',
      'model',
    ]);
    expect(gaps[1]).toMatchObject({ keyMissing: true, reasons: ['Research checks facts'] });
  });

  it('does not count Wikipedia as web search, even with a Brave key saved', () => {
    const gaps = craftbookSetupGaps({ services }, { ...READY, webSearchProvider: 'wikipedia' });
    expect(gaps).toEqual([
      { kind: 'web-search', keyMissing: false, reasons: ['Research checks facts'] },
    ]);
  });

  it('treats Brave without its key as missing', () => {
    const gaps = craftbookSetupGaps({ services }, { ...READY, hasBraveSearchApiKey: false });
    expect(gaps).toMatchObject([{ kind: 'web-search', keyMissing: true }]);
  });

  it('needs only External services for a book that fetches pages but does not search', () => {
    const gaps = craftbookSetupGaps(
      { services: [{ kind: 'external-services' }] },
      { ...READY, allowExternalServices: false, webSearchProvider: undefined },
    );
    expect(gaps).toEqual([{ kind: 'external-services', reasons: [] }]);
  });

  it('checks each model against its own engine', () => {
    const gaps = craftbookSetupGaps(
      { models: [{ id: 'qwen3.8-27b-q4', provider: 'mlx', reasons: [] }] },
      READY,
    );
    expect(gaps).toEqual([{ kind: 'model', id: 'qwen3.8-27b-q4', provider: 'mlx', reasons: [] }]);
  });
});
