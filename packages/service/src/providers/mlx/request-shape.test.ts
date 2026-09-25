import { describe, expect, it } from 'vitest';
import type { ResolvedModelProfile } from '../../model-profile/types.js';
import { applyMlxRequestShape } from './request-shape.js';

const qwen = (ids: string[], template?: string): ResolvedModelProfile =>
  ({
    catalogId: 'qwen-test',
    tier: 'large',
    style: { family: 'qwen', reasoningFormat: 'think', toolCallFormat: 'function-call' },
    behaviors: ids.map((id) => ({
      id,
      config: id === 'tools.mlx-template-fix' ? { template } : undefined,
      behavior: {} as never,
    })),
  }) as ResolvedModelProfile;

describe('applyMlxRequestShape', () => {
  it('adds the tool grammar only when the request carries tools', () => {
    const profile = qwen(['tools.mlx-grammar']);
    const withTools: Record<string, unknown> = {};
    applyMlxRequestShape(withTools, { profile }, { hasTools: true });
    expect(withTools.tool_grammar).toEqual({ format: 'hermes', mode: 'name-and-params' });

    const without: Record<string, unknown> = {};
    applyMlxRequestShape(without, { profile }, { hasTools: false });
    expect(without).not.toHaveProperty('tool_grammar');
  });

  it('applies the curated template override when the profile carries one', () => {
    const body: Record<string, unknown> = {};
    applyMlxRequestShape(
      body,
      { profile: qwen(['tools.mlx-template-fix'], '{{ curated }}') },
      { hasTools: false },
    );
    expect(body.chat_template_override).toBe('{{ curated }}');
  });

  it('leaves the body untouched with no tuning and no opted-in behaviors', () => {
    const body: Record<string, unknown> = { model: 'm' };
    applyMlxRequestShape(body, { profile: qwen([]) }, { hasTools: true });
    expect(body).toEqual({ model: 'm' });
  });
});
