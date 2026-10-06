import { describe, expect, it } from 'vitest';
import { lookupBehavior } from '../model-profile/index.js';
import { buildInstructions } from './instructions.js';
import { roleToolAllowlist } from './role-tool-filter.js';

describe('Conversationalist prompt', () => {
  it('supports research and prose without foreman routing or the full action cookbook', () => {
    const prompt = buildInstructions({
      name: 'Mira',
      role: 'Conversationalist',
      about: 'Explore ideas and answer questions in conversation.',
      providerName: 'llama-cpp',
      localModelTier: 'medium',
      generalistKickoff: 'on',
      availableTools: [...roleToolAllowlist('Conversationalist')].map((name) => ({
        name,
        description: name,
      })),
      profile: {
        catalogId: 'gemma4-31b-q4',
        tier: 'medium',
        style: { family: 'gemma', reasoningFormat: 'channel', toolCallFormat: 'function-call' },
        behaviors: [
          {
            id: 'prompt.tool-cookbook-full',
            config: undefined,
            behavior: lookupBehavior('prompt.tool-cookbook-full')!,
          },
        ],
      },
    }).full;
    expect(prompt).toContain('answer questions in conversation');
    expect(prompt).toContain('with the detail it needs');
    expect(prompt).not.toContain('Your job is to ROUTE');
    expect(prompt).not.toContain('Cookbook — common patterns');
    expect(prompt).not.toContain('write one sentence about what happened');
    expect(prompt).toContain('ask_specialist');
    expect(prompt).toContain('invoke_craftbook');
  });
});
