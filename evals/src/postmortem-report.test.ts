import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TrialFacts } from './bin/score-trial.ts';
import { discoverTrialCandidates, writeTrialReport } from './postmortem-report.ts';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'gezel-postmortem-report-test-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

function completeFacts(trialId: string): TrialFacts {
  return {
    trialId,
    scenarioId: 'non-html-task',
    modelId: 'test-model',
    runDir: join(tempRoot, trialId),
    outcome: {
      success: true,
      reason: 'passed',
      durationMs: 10_000,
      timeoutMs: 60_000,
      budgetUsedFraction: 0.2,
    },
    timing: {
      startedAt: '2026-07-10T00:00:00.000Z',
      finishedAt: '2026-07-10T00:00:10.000Z',
      timeToFirstArtifactMs: 1_000,
      timeToLastArtifactWriteMs: 2_000,
      timeToFirstTokenMs: 100,
      firstTurnTtftMs: 50,
      timeToFirstToolCallMs: 500,
    },
    team: { totalGezelsCreated: 3, rolesCreated: ['Meester'], missingExpectedRoles: [] },
    toolUse: { totalToolCalls: 2, byTool: { writeFile: 1 }, redFlags: [] },
    artifacts: { htmlFiles: [], imageFiles: [], otherFileCount: 1 },
    sniff: {
      progression: [],
      latest: {
        filePath: 'workspace/report.md',
        bytes: 2_000,
        score: 4,
        scoreMax: 4,
        signals: ['complete'],
        failReason: null,
      },
    },
    autoAnswer: { total: 0, byKind: { structured: 0, inline: 0 }, events: [] },
    miscEvents: [],
    host: {
      cpuModel: 'Test CPU',
      totalRamGb: 32,
      gpuModel: 'Test GPU',
      framework: 'llama-cpp',
      frameworkBinary: 'llama-server',
    },
    perf: {
      process: { peakRssMb: 100 },
      gpu: { peakUtilPercent: 50, peakMemUsedMb: 1_000, memTotalMb: 2_000 },
      usage: { totalInputTokens: 100, totalOutputTokens: 50 },
      derived: { meanTokensPerSec: 10 },
    },
  };
}

async function writeCompleteTrial(dir: string, trialId: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'facts.json'), JSON.stringify(completeFacts(trialId)));
  await writeFile(
    join(dir, 'result.json'),
    JSON.stringify({ trialId, success: true, failureClass: 'pass' }),
  );
}

describe('postmortem report filesystem workflow', () => {
  it('discovers marker directories, prunes captured workspaces, and skips active trials', async () => {
    const complete = join(tempRoot, 'model', 'scenario', 'trial-complete');
    const active = join(tempRoot, 'model', 'scenario', 'trial-active');
    await writeCompleteTrial(complete, 'trial-complete');
    await mkdir(active, { recursive: true });
    await writeFile(join(active, 'status.json'), '{}');
    await mkdir(join(complete, 'workspace', 'nested'), { recursive: true });
    await writeFile(join(complete, 'workspace', 'nested', 'facts.json'), '{}');

    expect(await discoverTrialCandidates(tempRoot)).toEqual([active, complete].sort());
    expect(await writeTrialReport(active)).toMatchObject({ status: 'skipped-active' });
  });

  it('writes score and deterministic postmortem files, preserves them by default, and forces replacement', async () => {
    const dir = join(tempRoot, 'trial');
    await writeCompleteTrial(dir, 'trial');

    expect(await writeTrialReport(dir)).toMatchObject({ status: 'written' });
    const score = JSON.parse(await readFile(join(dir, 'score.json'), 'utf8')) as {
      composite: number;
      eligibility: { includedInModelAggregate: boolean };
    };
    const initialPostmortem = await readFile(join(dir, 'postmortem.md'), 'utf8');
    expect(score).toMatchObject({
      composite: 10,
      eligibility: { includedInModelAggregate: true },
    });
    expect(initialPostmortem).toContain('**Composite: 10.0 / 10**');
    expect(initialPostmortem).toContain('## Performance');
    expect(initialPostmortem).toContain('## Evidence map');
    expect(initialPostmortem).toContain('## Enrichment needed');

    await writeFile(join(dir, 'postmortem.md'), 'manual content\n');
    expect(await writeTrialReport(dir)).toMatchObject({ status: 'skipped-existing' });
    expect(await readFile(join(dir, 'postmortem.md'), 'utf8')).toBe('manual content\n');

    expect(await writeTrialReport(dir, { force: true })).toMatchObject({ status: 'written' });
    expect(await readFile(join(dir, 'postmortem.md'), 'utf8')).toBe(initialPostmortem);
  });

  it('skips incomplete terminal candidates without writing either report', async () => {
    const dir = join(tempRoot, 'incomplete');
    await mkdir(dir);
    await writeFile(join(dir, 'result.json'), '{}');

    expect(await writeTrialReport(dir)).toMatchObject({ status: 'skipped-incomplete' });
  });

  it('refuses a partial existing report pair unless force repairs it', async () => {
    const dir = join(tempRoot, 'partial-report');
    await writeCompleteTrial(dir, 'partial-report');
    await writeFile(join(dir, 'score.json'), '{}');

    await expect(writeTrialReport(dir)).rejects.toThrow('partial report pair');
    expect(await writeTrialReport(dir, { force: true })).toMatchObject({ status: 'written' });
    expect(await readFile(join(dir, 'postmortem.md'), 'utf8')).toContain(
      '**Composite: 10.0 / 10**',
    );
  });
});
