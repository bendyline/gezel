import { describe, expect, it } from 'vitest';
import {
  KeurmeesterActionSchema,
  KeurmeesterCaseRecordSchema,
  KeurmeesterVerdictSchema,
} from './keurmeester.js';

describe('KeurmeesterVerdict schema', () => {
  it('parses a corrective_prompt verdict', () => {
    const verdict = KeurmeesterVerdictSchema.parse({
      diagnosis: 'Model finished reasoning but never emitted the writeFile call.',
      failureClass: 'silent_stall',
      action: {
        kind: 'corrective_prompt',
        prompt: 'Stop reading. Your next call MUST be writeFile for review.md.',
      },
      confidence: 'high',
    });
    expect(verdict.action.kind).toBe('corrective_prompt');
  });

  it('parses each action kind of the ladder', () => {
    const actions = [
      { kind: 'corrective_prompt', prompt: 'do the thing' },
      { kind: 'rewrite_step', stepId: 's1', prompt: 'new step prompt' },
      {
        kind: 'rewrite_craftbook',
        document: '# Craftbook\n…',
        rationale: 'decompose the image loop into a gated step',
      },
      { kind: 'takeover_step', instruction: 'patch the syntax error in game.js' },
      { kind: 'stand_down', reason: 'infra failure, not a model problem' },
    ];
    for (const action of actions) {
      expect(KeurmeesterActionSchema.parse(action).kind).toBe(action.kind);
    }
  });

  it('rejects an unknown action kind', () => {
    expect(() => KeurmeesterActionSchema.parse({ kind: 'reboot_universe', prompt: 'x' })).toThrow();
  });

  it('rejects a corrective_prompt without a prompt', () => {
    expect(() =>
      KeurmeesterVerdictSchema.parse({
        diagnosis: 'stuck',
        failureClass: 'tool_loop',
        action: { kind: 'corrective_prompt', prompt: '' },
        confidence: 'low',
      }),
    ).toThrow();
  });

  it('rejects an unknown failureClass', () => {
    expect(() =>
      KeurmeesterVerdictSchema.parse({
        diagnosis: 'stuck',
        failureClass: 'gremlins',
        action: { kind: 'stand_down', reason: 'n/a' },
        confidence: 'low',
      }),
    ).toThrow();
  });
});

describe('Keurmeester case records', () => {
  it('round-trips an opened/closed pair through the discriminated union', () => {
    const opened = KeurmeesterCaseRecordSchema.parse({
      record: 'case.opened',
      caseId: 'kc-123',
      ts: '2026-07-06T12:00:00.000Z',
      trigger: 'nudge_budget_exhausted',
      sessionId: 'sess-1',
      gezelId: 'gez-1',
      projectId: 'proj-1',
      providerName: 'llama-cpp',
      model: 'qwen3.5-9b-q4',
      modelTier: 'small',
      consultProviderName: 'anthropic',
      consultModel: 'claude-sonnet-5',
      signals: { continuations: 2, toolCallsThisTurn: 0 },
      verdict: {
        diagnosis: 'silent stall after reasoning',
        failureClass: 'silent_stall',
        action: { kind: 'corrective_prompt', prompt: 'write the file now' },
        confidence: 'medium',
      },
      applied: true,
      consultDurationMs: 8400,
      promptChars: 6200,
      responseChars: 410,
    });
    expect(opened.record).toBe('case.opened');

    const closed = KeurmeesterCaseRecordSchema.parse({
      record: 'case.closed',
      caseId: 'kc-123',
      ts: '2026-07-06T12:05:00.000Z',
      outcome: 'unblocked',
      turnsObserved: 1,
    });
    expect(closed.record).toBe('case.closed');
  });

  it('accepts a verdict-less opened record (consult itself failed)', () => {
    const parsed = KeurmeesterCaseRecordSchema.parse({
      record: 'case.opened',
      caseId: 'kc-456',
      ts: '2026-07-06T12:00:00.000Z',
      trigger: 'step_redrive_exhausted',
      gezelId: 'gez-2',
      providerName: 'ollama',
      consultProviderName: 'openai',
      signals: {},
      applied: false,
      consultDurationMs: 120000,
      promptChars: 5000,
      responseChars: 0,
    });
    expect(parsed.record === 'case.opened' && parsed.verdict).toBeUndefined();
  });

  it('rejects an unknown outcome', () => {
    expect(() =>
      KeurmeesterCaseRecordSchema.parse({
        record: 'case.closed',
        caseId: 'kc-789',
        ts: '2026-07-06T12:00:00.000Z',
        outcome: 'party',
        turnsObserved: 0,
      }),
    ).toThrow();
  });
});
