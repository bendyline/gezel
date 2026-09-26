import { describe, expect, it } from 'vitest';
import { retrievalArmProof, summarizeRetrieval } from './retrieval-facts.ts';

const injected = (sessionId: string, hits: Array<Record<string, unknown>>, extra = {}) => ({
  id: `evt-${sessionId}-${hits.length}`,
  kind: 'retrieval.context-injected',
  details: {
    sessionId,
    mode: 'balanced',
    inheritedFrom: 'install',
    estimatedTokens: 120,
    hits,
    rejected: { floor: 2, grounding: 1 },
    ...extra,
  },
});

describe('summarizeRetrieval', () => {
  const facts = summarizeRetrieval({
    arm: { mode: 'balanced', references: true, embeddings: true },
    events: [
      injected('s1', [{ source: 'knowledge', docKey: 'knowledge://p/c/halvard-golden' }]),
      injected('s2', []),
    ],
    sessions: [
      {
        id: 's1',
        messages: [
          { retrieval: { hits: [{}] } },
          {
            toolCalls: [{ name: 'read_document', argsFull: 'uri: knowledge://p/c/halvard-golden' }],
          },
        ],
      },
    ],
    state: {
      tasks: {
        tasks: [
          {
            ref: 'p/1',
            references: { items: [{ uri: 'knowledge://p/c/halvard-golden#chunk=a' }] },
          },
          { ref: 'p/2' },
        ],
      },
    },
    daemonLog: '[tasks] references subject="halvard" terms=halvard searched=9 kept=1\n',
    oracle: { golden: ['knowledge://p/c/halvard-golden'], decoys: ['knowledge://p/c/brewing'] },
  });

  it('counts what each channel put in front of the model', () => {
    expect(facts.turn).toMatchObject({
      probes: 2,
      injections: 1,
      hitsBySource: { knowledge: 1 },
      injectedTokens: 240,
      rejected: { floor: 4, grounding: 2 },
      sessionsWithInjection: 1,
    });
    expect(facts.references).toMatchObject({
      searches: 1,
      tasks: 2,
      tasksWithReferences: 1,
      items: 1,
      citations: ['knowledge://p/c/halvard-golden'],
    });
    expect(facts.stampedMessages).toBe(1);
  });

  it('traces the oracle documents through every channel', () => {
    expect(facts.exposure?.['knowledge://p/c/halvard-golden']).toEqual({
      referenced: true,
      injected: true,
      readByTool: true,
    });
    expect(facts.exposure?.['knowledge://p/c/brewing']).toEqual({
      referenced: false,
      injected: false,
      readByTool: false,
    });
  });

  it('proves a treatment arm was applied', () => {
    expect(retrievalArmProof(facts)).toEqual({ ok: true, problems: [] });
  });
});

describe('retrievalArmProof', () => {
  const base = { sessions: [], state: null, daemonLog: '', oracle: null } as const;

  it('fails a control arm that injected anything', () => {
    const facts = summarizeRetrieval({
      ...base,
      arm: { mode: 'off', references: false, embeddings: true },
      events: [injected('s1', [{ source: 'shared', path: 'x.md' }])],
    });
    expect(retrievalArmProof(facts).ok).toBe(false);
  });

  it('fails a treatment arm whose turns ran under another policy source', () => {
    const facts = summarizeRetrieval({
      ...base,
      arm: { mode: 'balanced', references: false, embeddings: true },
      events: [injected('s1', [], { inheritedFrom: 'craftbook-step' })],
    });
    expect(retrievalArmProof(facts).problems).toEqual([
      'some turns ran under another policy source: craftbook-step',
    ]);
  });

  it('fails a treatment arm in which retrieval never ran', () => {
    const facts = summarizeRetrieval({
      ...base,
      arm: { mode: 'lean', references: false, embeddings: true },
      events: [],
    });
    expect(retrievalArmProof(facts).problems).toContain('per-turn retrieval never ran');
  });

  it('fails a relevance arm whose model only ever answered cold', () => {
    const arm = {
      mode: 'balanced' as const,
      references: false,
      embeddings: true,
      relevanceModel: { modelId: 'm@1' },
    };
    const cold = summarizeRetrieval({
      ...base,
      arm,
      events: [injected('s1', [], { relevanceModel: { status: 'cold' } })],
    });
    expect(retrievalArmProof(cold).problems).toEqual([
      'the relevance model never scored a candidate',
    ]);
    const scored = summarizeRetrieval({
      ...base,
      arm,
      events: [injected('s1', [], { relevanceModel: { status: 'cold' } })],
      daemonLog:
        '[tasks] references subject="quiche" terms=quiche searched=9 kept=2 relevance=scored',
    });
    expect(scored.references.relevance).toEqual({ scored: 1 });
    expect(retrievalArmProof(scored).ok).toBe(true);
  });

  it('fails an arm without the model in which it scored anyway', () => {
    const facts = summarizeRetrieval({
      ...base,
      arm: { mode: 'balanced', references: false, embeddings: true },
      events: [injected('s1', [], { relevanceModel: { status: 'scored' } })],
    });
    expect(retrievalArmProof(facts).problems).toEqual([
      'the relevance model scored 1 searches in an arm without it',
    ]);
  });
});
