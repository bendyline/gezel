import type { GezelGrowthState } from '@bendyline/gezel';
import { GezelGrowthStateSchema } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import type { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import {
  type CorpusEntry,
  buildPayoutOptions,
  generateProposals,
  parseProposalOutput,
} from './proposals.js';

const corpus: CorpusEntry[] = [
  {
    day: '2026-06-01',
    kind: 'pref',
    text: 'User asked for failing tests to be written before any implementation code.',
  },
  {
    day: '2026-06-05',
    kind: 'pref',
    text: 'User again requested tests-first development on the parser change.',
  },
  { day: '2026-06-08', kind: 'fact', text: 'The deploy script lives in scripts/deploy.sh.' },
];

function block(parts: { title: string; trait: string; evidence: string[] }): string {
  return [
    'PROPOSAL',
    `TITLE: ${parts.title}`,
    `TRAIT: ${parts.trait}`,
    ...parts.evidence.map((e) => `EVIDENCE: ${e}`),
    'END',
  ].join('\n');
}

describe('parseProposalOutput', () => {
  it('parses a valid proposal and rewrites evidence day/kind from the matched entry', () => {
    const raw = block({
      title: 'Tests first',
      trait: 'Write failing tests before touching implementation code.',
      evidence: [
        // Wrong date on purpose — must be rewritten from the corpus.
        '2099-01-01 :: User asked for failing tests to be written before any implementation code.',
        '2026-06-05 :: User again requested tests-first development on the parser change.',
      ],
    });
    const drafts = parseProposalOutput(raw, corpus);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.evidence).toHaveLength(2);
    expect(drafts[0]!.evidence[0]!.day).toBe('2026-06-01'); // rewritten, not 2099
    expect(drafts[0]!.evidence[0]!.kind).toBe('pref');
  });

  it('accepts long substrings but drops short or fabricated evidence', () => {
    const raw = block({
      title: 'Tests first',
      trait: 'Write failing tests before touching implementation code.',
      evidence: [
        // ≥24-char substring of a real entry — survives.
        '2026-06-01 :: failing tests to be written before any implementation',
        // Short fragment — dropped even though it appears in an entry.
        '2026-06-01 :: failing tests',
        // Fully fabricated — dropped.
        '2026-06-02 :: User loves enterprise Java patterns everywhere.',
      ],
    });
    const drafts = parseProposalOutput(raw, corpus);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.evidence).toHaveLength(1);
  });

  it('drops proposals whose evidence is entirely fabricated', () => {
    const raw = block({
      title: 'Invented',
      trait: 'Always use enterprise Java patterns.',
      evidence: ['2026-06-02 :: Something that never happened in any memory.'],
    });
    expect(parseProposalOutput(raw, corpus)).toEqual([]);
  });

  it('returns [] on NONE and empty output', () => {
    expect(parseProposalOutput('NONE', corpus)).toEqual([]);
    expect(parseProposalOutput('', corpus)).toEqual([]);
  });

  it('rejects overlong trait sentences instead of truncating', () => {
    const raw = block({
      title: 'Too long',
      trait: `Do the thing ${'x'.repeat(250)}.`,
      evidence: ['2026-06-08 :: The deploy script lives in scripts/deploy.sh.'],
    });
    expect(parseProposalOutput(raw, corpus)).toEqual([]);
  });

  it('sorts strongest-first by surviving evidence count and tolerates bullets', () => {
    const raw = [
      block({
        title: 'Weak',
        trait: 'Keep deploy scripts under scripts.',
        evidence: ['2026-06-08 :: The deploy script lives in scripts/deploy.sh.'],
      }),
      block({
        title: 'Strong',
        trait: 'Write failing tests before touching implementation code.',
        evidence: [
          '2026-06-01 :: User asked for failing tests to be written before any implementation code.',
          '2026-06-05 :: User again requested tests-first development on the parser change.',
        ],
      }),
    ].join('\n');
    const withBullets = raw
      .split('\n')
      .map((l) => (l.startsWith('EVIDENCE') ? `- ${l}` : l))
      .join('\n');
    const drafts = parseProposalOutput(withBullets, corpus);
    expect(drafts.map((d) => d.title)).toEqual(['Strong', 'Weak']);
  });
});

describe('buildPayoutOptions', () => {
  it('even levels offer a profile switch from the adjacency table', () => {
    const options = buildPayoutOptions({ tuningProfile: 'thinking-coding' }, 4, new Set());
    const tuning = options.find((o) => o.kind === 'tuning');
    expect(tuning?.kind === 'tuning' && tuning.action).toEqual({
      type: 'profile',
      profile: 'thinking-precise',
    });
  });

  it('odd levels offer a temperature nudge with parity-based direction', () => {
    const down = buildPayoutOptions({}, 3, new Set());
    const downTuning = down.find((o) => o.kind === 'tuning');
    expect(downTuning?.kind === 'tuning' && downTuning.action).toEqual({
      type: 'temperature',
      delta: -0.1,
    });
    const up = buildPayoutOptions({}, 5, new Set());
    const upTuning = up.find((o) => o.kind === 'tuning');
    expect(upTuning?.kind === 'tuning' && upTuning.action).toEqual({
      type: 'temperature',
      delta: 0.1,
    });
  });

  it('always carries a cosmetic — catalog entry when one is locked, milestone otherwise', () => {
    const withCatalog = buildPayoutOptions({}, 2, new Set());
    const cosmetic = withCatalog.find((o) => o.kind === 'cosmetic');
    expect(cosmetic?.kind === 'cosmetic' && cosmetic.cosmeticId).toBe('hat.straw');

    const allUnlocked = new Set([
      'hat.straw',
      'hat.newsboy',
      'accessory.monocle',
      'dress.apron',
      'accessory.brooch',
      'hat.hood',
      'accessory.eyepatch',
    ]);
    const milestone = buildPayoutOptions({}, 9, allUnlocked);
    const fallback = milestone.find((o) => o.kind === 'cosmetic');
    expect(fallback?.kind === 'cosmetic' && fallback.cosmeticId).toBe('level-9');
  });
});

describe('generateProposals', () => {
  const state = (over: Partial<GezelGrowthState> = {}): GezelGrowthState =>
    GezelGrowthStateSchema.parse(over);

  function stubs(opts: { entries?: CorpusEntry[]; klerkReply?: string | Error }) {
    const memory = {
      allEntries: async () =>
        (opts.entries ?? []).map((e) => ({ ...e, scope: 'gezel', id: 'ada', at: 'now' })),
    } as unknown as MemoryManager;
    const store = {
      getGezel: async () => ({ parsed: { frontmatter: { traits: [] } } }),
      readMemoryLessons: async () => '',
    } as unknown as Store;
    const oneShot = async () => {
      if (opts.klerkReply instanceof Error) throw opts.klerkReply;
      return opts.klerkReply ?? 'NONE';
    };
    return { memory, store, oneShot };
  }

  // Fresh entries (today) so the 45-day lookback keeps them.
  const today = new Date().toISOString().slice(0, 10);
  const freshCorpus: CorpusEntry[] = corpus.map((e) => ({ ...e, day: today }));

  it('combines validated traits with payout options', async () => {
    const reply = block({
      title: 'Tests first',
      trait: 'Write failing tests before touching implementation code.',
      evidence: [
        `${today} :: User asked for failing tests to be written before any implementation code.`,
      ],
    });
    const proposals = await generateProposals({
      ...stubs({ entries: freshCorpus, klerkReply: reply }),
      gezelId: 'ada',
      toLevel: 2,
      state: state(),
      frontmatter: {},
      allowKlerk: true,
    });
    expect(proposals.map((p) => p.kind)).toEqual(['trait', 'tuning', 'cosmetic']);
  });

  it('degrades to payout-only on Klerk failure, NONE, and allowKlerk=false', async () => {
    for (const cfg of [
      stubs({ entries: freshCorpus, klerkReply: new Error('klerk down') }),
      stubs({ entries: freshCorpus, klerkReply: 'NONE' }),
    ]) {
      const proposals = await generateProposals({
        ...cfg,
        gezelId: 'ada',
        toLevel: 2,
        state: state(),
        frontmatter: {},
        allowKlerk: true,
      });
      expect(proposals.map((p) => p.kind)).toEqual(['tuning', 'cosmetic']);
    }
    let klerkCalled = false;
    const cfg = stubs({ entries: freshCorpus });
    const proposals = await generateProposals({
      ...cfg,
      oneShot: async () => {
        klerkCalled = true;
        return 'NONE';
      },
      gezelId: 'ada',
      toLevel: 2,
      state: state(),
      frontmatter: {},
      allowKlerk: false,
    });
    expect(klerkCalled).toBe(false);
    expect(proposals.map((p) => p.kind)).toEqual(['tuning', 'cosmetic']);
  });

  it('never re-offers declined trait texts', async () => {
    const reply = block({
      title: 'Tests first',
      trait: 'Write failing tests before touching implementation code.',
      evidence: [
        `${today} :: User asked for failing tests to be written before any implementation code.`,
      ],
    });
    const proposals = await generateProposals({
      ...stubs({ entries: freshCorpus, klerkReply: reply }),
      gezelId: 'ada',
      toLevel: 2,
      state: state({
        declinedProposals: [
          {
            kind: 'trait',
            title: 'Tests first',
            traitText: 'Write failing tests before touching implementation code.',
            level: 2,
            declinedAt: 'now',
          },
        ],
      }),
      frontmatter: {},
      allowKlerk: true,
    });
    expect(proposals.map((p) => p.kind)).toEqual(['tuning', 'cosmetic']);
  });
});
