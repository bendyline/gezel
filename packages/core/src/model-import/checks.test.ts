import { describe, expect, it } from 'vitest';
import { type ModelImportEvidence, buildModelImportChecks, modelImportBlocked } from './checks.js';
import type { GgufHeaderFacts } from './gguf-header.js';

const TOOL_TEMPLATE =
  '{%- if tools %}{{ tools | tojson }}{% endif %}{% for m in messages %}<|im_start|>{{ m.role }}{% endfor %}';

function header(overrides: Partial<GgufHeaderFacts> = {}): GgufHeaderFacts {
  return {
    version: 3,
    architecture: 'qwen3',
    chatTemplate: TOOL_TEMPLATE,
    tokenizerModel: 'gpt2',
    contextLength: 40_960,
    tensorTypeCounts: { 0: 100, 12: 200, 14: 30 },
    ...overrides,
  };
}

function evidence(overrides: Partial<ModelImportEvidence> = {}): ModelImportEvidence {
  return {
    access: { gated: false, private: false, disabled: false, hasToken: false },
    header: header(),
    allFilesHashed: true,
    fit: { tier: 'fits', label: 'fits in memory', detail: 'Runs fully.', runnable: true },
    disk: { ok: true, downloadBytes: 5 * 1024 ** 3, neededBytes: 6 * 1024 ** 3 },
    ...overrides,
  };
}

function statusOf(e: ModelImportEvidence, id: string) {
  return buildModelImportChecks(e).find((item) => item.id === id)?.status;
}

describe('buildModelImportChecks', () => {
  it('passes a well-formed tool-capable chat model', () => {
    const checks = buildModelImportChecks(evidence());
    expect(checks.every((item) => item.status === 'pass')).toBe(true);
    expect(modelImportBlocked(checks)).toBe(false);
  });

  it('blocks gated repos without a token, and only warns with one', () => {
    const gated = buildModelImportChecks(
      evidence({
        access: { gated: 'manual', private: false, disabled: false, hasToken: false },
        allFilesHashed: false,
      }),
    );
    expect(gated.find((item) => item.id === 'access')?.status).toBe('fail');
    // The hidden checksums and file follow from the gate; they are not repeated.
    expect(gated.map((item) => item.id)).toEqual(['access', 'memory', 'disk']);
    expect(
      statusOf(
        evidence({ access: { gated: 'auto', private: false, disabled: false, hasToken: true } }),
        'access',
      ),
    ).toBe('warn');
  });

  it('blocks a download it cannot verify', () => {
    expect(statusOf(evidence({ allFilesHashed: false }), 'integrity')).toBe('fail');
  });

  it('blocks an unreadable header', () => {
    const { header: _drop, ...rest } = evidence();
    const checks = buildModelImportChecks({ ...rest, headerError: 'not a GGUF file' });
    expect(checks.find((item) => item.id === 'format')?.detail).toContain('not a GGUF file');
    expect(modelImportBlocked(checks)).toBe(true);
  });

  it('tells adapters, projectors and embedding models apart from chat models', () => {
    expect(statusOf(evidence({ header: header({ generalType: 'adapter' }) }), 'kind')).toBe('fail');
    expect(statusOf(evidence({ header: header({ architecture: 'clip' }) }), 'kind')).toBe('fail');
    const embedding = buildModelImportChecks(
      evidence({ header: header({ architecture: 'bert', chatTemplate: undefined }) }),
    );
    expect(embedding.find((item) => item.id === 'kind')?.detail).toContain('embedding');
    // The rest of the header is beside the point once the kind is wrong.
    expect(embedding.some((item) => item.id === 'architecture')).toBe(false);
  });

  it('blocks a design the pinned engine does not know', () => {
    const checks = buildModelImportChecks(
      evidence({ header: header({ architecture: 'not-a-real-design' }) }),
    );
    const arch = checks.find((item) => item.id === 'architecture');
    expect(arch?.status).toBe('fail');
    expect(arch?.detail).toContain('not-a-real-design');
  });

  it('blocks removed and unknown tensor formats', () => {
    expect(
      statusOf(evidence({ header: header({ tensorTypeCounts: { 31: 10 } }) }), 'tensorTypes'),
    ).toBe('fail');
    expect(
      statusOf(evidence({ header: header({ tensorTypeCounts: { 99: 1 } }) }), 'tensorTypes'),
    ).toBe('fail');
    expect(statusOf(evidence({ backendGap: 'slow here' }), 'tensorTypes')).toBe('warn');
  });

  it('blocks a model with no conversation format and warns when it has no tools', () => {
    expect(
      statusOf(evidence({ header: header({ chatTemplate: undefined }) }), 'chatTemplate'),
    ).toBe('fail');
    expect(
      statusOf(evidence({ header: header({ chatTemplate: '{{ messages }}' }) }), 'toolCalls'),
    ).toBe('warn');
  });

  it('warns on a short context window', () => {
    expect(statusOf(evidence({ header: header({ contextLength: 4096 }) }), 'context')).toBe('warn');
  });

  it('blocks a model too big for the machine or the disk', () => {
    expect(
      statusOf(
        evidence({
          fit: { tier: 'too-big', label: 'may not fit', detail: 'Too big.', runnable: false },
        }),
        'memory',
      ),
    ).toBe('fail');
    expect(
      statusOf(
        evidence({
          disk: {
            ok: false,
            downloadBytes: 8 * 1024 ** 3,
            neededBytes: 10 * 1024 ** 3,
            freeBytes: 1024 ** 3,
          },
        }),
        'disk',
      ),
    ).toBe('fail');
  });
});
