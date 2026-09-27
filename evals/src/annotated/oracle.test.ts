import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ANNOTATED_ORACLES,
  CHAT_POLICY_ORACLE,
  DECK_KNOWLEDGE_ORACLE,
  annotatedChatPolicyClosedScenario,
  annotatedChatPolicyScenario,
  annotatedDeckScenarios,
} from '../scenarios/annotated-work.ts';
import { deliverableTextFromRunDir, gradeText } from './oracle.ts';

describe('gradeText', () => {
  it('accepts any surface form of a fact and flags superseded figures', () => {
    const grade = gradeText(
      'Yes — within sixty days, with a 10 percent restocking fee. (The old 21-day rule is gone.)',
      CHAT_POLICY_ORACLE,
    );
    expect(grade).toMatchObject({
      factScore: 1,
      found: ['window', 'fee'],
      missing: [],
      forbiddenHits: ['21-day'],
      deliverableFound: true,
    });
  });

  it('scores a missing deliverable as absent, not as zero facts found in text', () => {
    expect(gradeText(null, DECK_KNOWLEDGE_ORACLE)).toMatchObject({
      factScore: null,
      deliverableFound: false,
    });
  });
});

describe('deliverableTextFromRunDir', () => {
  let runDir: string;
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it('reads a workspace deliverable and the worker’s latest reply', async () => {
    runDir = await mkdtemp(join(tmpdir(), 'annotated-oracle-'));
    await mkdir(join(runDir, 'workspace', 'proj-1', 'powerpoint', 'eval'), { recursive: true });
    await writeFile(
      join(runDir, 'workspace', 'proj-1', 'powerpoint', 'eval', 'deck.md'),
      '# Halvard\n\n4 berths, 21.4 → 12.8 minutes',
    );
    expect(deliverableTextFromRunDir(runDir, DECK_KNOWLEDGE_ORACLE)).toContain('21.4');

    await mkdir(join(runDir, 'sessions'));
    await writeFile(
      join(runDir, 'sessions', 'noor--abc.json'),
      JSON.stringify({
        messages: [
          { role: 'user', content: 'q', at: '2026-01-01T00:00:00Z' },
          { role: 'assistant', content: 'within 60 days, 10% fee', at: '2026-01-01T00:01:00Z' },
        ],
      }),
    );
    expect(deliverableTextFromRunDir(runDir, CHAT_POLICY_ORACLE)).toBe('within 60 days, 10% fee');
  });
});

describe('annotated-work scenarios', () => {
  it('build, carry a retrieval oracle, and have one grading oracle each', () => {
    const scenarios = [
      ...annotatedDeckScenarios(),
      annotatedChatPolicyScenario,
      annotatedChatPolicyClosedScenario,
    ];
    expect(scenarios.map((scenario) => scenario.id).sort()).toEqual(
      Object.keys(ANNOTATED_ORACLES).sort(),
    );
    for (const scenario of scenarios) {
      expect(scenario.requiresEmbeddings).toBe(true);
      expect(scenario.retrievalOracle).toEqual(ANNOTATED_ORACLES[scenario.id]?.retrieval);
    }
  });
});
