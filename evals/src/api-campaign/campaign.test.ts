import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { campaignOptions } from '../bin/api-campaign.ts';
import type { TrialResult } from '../types.ts';
import {
  type CampaignCell,
  assertCampaignEnvironment,
  campaignCells,
  campaignDefinition,
  trialArguments,
} from './plan.ts';
import { campaignReport, campaignStopReason, outcome } from './report.ts';
import { runCampaign } from './run.ts';

const script = [
  {
    kind: 'structured',
    prompt: 'Exact consent',
    intentKind: 'command-approval',
    answer: { choice: 'Allow' },
  },
];
function result(cell: CampaignCell, runDir: string): TrialResult {
  const assisted = cell.repairPolicy === 'harness';
  return {
    trialId: cell.id,
    runDir,
    scenarioId: cell.scenario,
    engine: cell.provider,
    modelId: cell.model,
    repairPolicy: cell.repairPolicy,
    generalistMode: 'on',
    success: true,
    reason: 'passed',
    startedAt: '2026-10-09T00:00:00Z',
    finishedAt: '2026-10-09T00:00:01Z',
    durationMs: 1000,
    qualification: {
      version: 1,
      passed: !assisted,
      artifactSuccess: true,
      independence: assisted ? 'assisted' : 'observed',
      issues: assisted ? ['assisted diagnostic; not independent product qualification'] : [],
      lifecycle: {
        status: 'complete',
        waitedMs: 1,
        tasks: [],
        inflightSessions: [],
        pendingQuestions: [],
        replies: [],
        completionClaim: 'supported',
      },
      toolFailures: 0,
      taskModes: [],
      interventions: { delivered: 0, blocked: 0, unanswered: 0, productRuntime: 0 },
      api: {
        toolRounds: 2,
        requests: 2,
        results: 2,
        failures: 0,
        incomplete: 0,
        sdkRetries: null,
        usage: {},
      },
      commandAudit: 'recorded-tool-calls',
    },
  };
}

describe('campaign plan and reporting', () => {
  it('interleaves balanced policy pairs and extends without repeating the screen', () => {
    const screen = campaignCells(1);
    expect(screen).toHaveLength(12);
    expect(campaignCells(3).slice(0, 12)).toEqual(screen);
    expect(new Set(campaignCells(3).map((c) => c.id)).size).toBe(36);
    const firstPolicies: string[] = [];
    for (let i = 0; i < screen.length; i += 2) {
      const a = screen[i]!;
      const b = screen[i + 1]!;
      expect([a.provider, a.scenario]).toEqual([b.provider, b.scenario]);
      expect(a.repairPolicy).not.toBe(b.repairPolicy);
      firstPolicies.push(a.repairPolicy);
    }
    expect(firstPolicies.filter((p) => p === 'runtime')).toHaveLength(3);
    for (const provider of ['openai', 'anthropic']) {
      const first = screen.filter((c, i) => i % 2 === 0 && c.provider === provider);
      expect(new Set(first.map((c) => c.repairPolicy)).size).toBe(2);
      const second = campaignCells(3)
        .slice(12, 24)
        .filter((c, i) => i % 2 === 0 && c.provider === provider);
      expect(second.map((c) => c.repairPolicy)).toEqual(
        first.map((c) => (c.repairPolicy === 'runtime' ? 'harness' : 'runtime')),
      );
    }
  });
  it('forwards all controls and scopes consent to its scenario in both arms', () => {
    for (const cell of campaignCells(1)) {
      const args = trialArguments(cell, '/runs/cell', '/runs/script.json');
      expect(args).toContain('--qualification');
      expect(args).toContain('--write-reports');
      expect(args.slice(args.indexOf('--generalist'), args.indexOf('--generalist') + 2)).toEqual([
        '--generalist',
        'on',
      ]);
      expect(args[args.indexOf('--repair-policy') + 1]).toBe(cell.repairPolicy);
      expect(args[args.indexOf('--provider') + 1]).toBe(cell.provider);
      expect(args[args.indexOf('--model') + 1]).toBe(cell.model);
      expect(args.includes('--user-script')).toBe(cell.scenario === 'craftbook-codemod-sweep');
      expect(args[args.indexOf('--user-simulation') + 1]).toBe(
        cell.scenario === 'craftbook-codemod-sweep' ? 'scripted' : 'disabled',
      );
    }
  });
  it.each([
    '--count',
    '--count 0',
    '--count 2',
    '--execute false',
    '--provider openai',
    '--timeout 1m',
  ])('rejects invalid or ignored flags: %s', (flags) => {
    expect(() => campaignOptions(['--runs-dir', 'evals/runs/test', ...flags.split(' ')])).toThrow();
  });
  it('defaults to planning and refuses ambient behavior changes', () => {
    expect(campaignOptions(['--runs-dir', 'evals/runs/test']).execute).toBe(false);
    expect(() => assertCampaignEnvironment({ GEZEL_FORCE_BEHAVIORS: 'hint' })).toThrow();
    expect(() => assertCampaignEnvironment({ GEZEL_REMOVE_BEHAVIORS: 'hint' })).toThrow();
    expect(() => campaignDefinition([])).toThrow();
  });
  it('counts assisted completion separately from qualification and notices unexercised assistance', () => {
    const cells = campaignCells(1).slice(0, 2);
    const rows = cells.map((cell) => ({ cell, result: result(cell, '/trial') }));
    expect(outcome(rows[1]!.result)).toMatchObject({ complete: true, qualified: false });
    expect(campaignStopReason(rows[1]!)).toBeUndefined();
    const report = campaignReport(cells, rows);
    expect(report).toContain('| openai | tictactoe | 1 | 1 | 0 | 0 | 0 | 0 |');
    expect(report).toContain('does not demonstrate their benefit');
  });
  it('stops on provider, consent and evidence failures but continues ordinary task failures', () => {
    const cell = campaignCells(1)[0]!;
    const row = { cell, result: result(cell, '/trial') };
    row.result.success = false;
    row.result.qualification!.artifactSuccess = false;
    row.result.qualification!.passed = false;
    row.result.qualification!.issues = ['artifact checks did not pass'];
    expect(campaignStopReason(row)).toBeUndefined();
    row.result.qualification!.api.failures = 1;
    expect(campaignStopReason(row)).toContain('API');
    row.result.qualification!.api.failures = 0;
    row.result.qualification!.issues.push(
      'user assistance was requested without a matching script',
    );
    expect(campaignStopReason(row)).toContain('user assistance');
  });

  it.each([
    'API provider returned 1 incomplete response(s): max_messages=1',
    'API result telemetry is missing for 1 request(s)',
    'API stream ended without a terminal event for 1 request(s)',
  ])('retains the specific API stop cause: %s', (issue) => {
    const cell = campaignCells(1)[0]!;
    const row = { cell, result: result(cell, '/trial') };
    row.result.qualification!.issues = [issue];
    row.result.qualification!.api.incomplete = 1;
    expect(campaignStopReason(row)).toBe(issue);
    expect(outcome(row.result).complete).toBe(false);
    expect(campaignReport([cell], [row], campaignStopReason(row))).toContain(issue);
  });
});

describe('campaign execution journal', () => {
  let dir: string;
  let deps: Parameters<typeof runCampaign>[1];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-api-campaign-'));
    deps = {
      identity: vi.fn(async () => ({ source: 'frozen' })),
      script: async () => script,
      execute: vi.fn(async (cell, cellDir) => {
        const trial = join(cellDir, 'trial');
        await mkdir(trial);
        await writeFile(join(trial, 'result.json'), JSON.stringify(result(cell, trial)));
      }),
      log: vi.fn(),
    };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  it('prepares without launching, resumes without repeating, then adds only 24 trials', async () => {
    const planned = await runCampaign({ runsDir: dir }, deps);
    expect(planned.cells).toHaveLength(12);
    expect(deps!.execute).not.toHaveBeenCalled();
    await runCampaign({ runsDir: dir, execute: true }, deps);
    expect(deps!.execute).toHaveBeenCalledTimes(12);
    await runCampaign({ runsDir: dir, execute: true }, deps);
    expect(deps!.execute).toHaveBeenCalledTimes(12);
    const extended = await runCampaign({ runsDir: dir, count: 3, execute: true }, deps);
    expect(deps!.execute).toHaveBeenCalledTimes(36);
    expect(extended.rows).toHaveLength(36);
    expect(JSON.parse(await readFile(join(dir, 'summary.json'), 'utf8')).recorded).toBe(36);
  });
  it('refuses changed identity or consent before making calls', async () => {
    await runCampaign({ runsDir: dir }, deps);
    deps!.identity = async () => ({ source: 'changed' });
    await expect(runCampaign({ runsDir: dir, execute: true }, deps)).rejects.toThrow('changed');
    deps!.identity = async () => ({ source: 'frozen' });
    deps!.script = async () => [{ ...script[0], prompt: 'Different permission' }];
    await expect(runCampaign({ runsDir: dir, execute: true }, deps)).rejects.toThrow('changed');
    expect(deps!.execute).not.toHaveBeenCalled();
  });
  it('stops after a demonstrated provider failure and does not retry it on resume', async () => {
    const original = deps!.execute;
    deps!.execute = vi.fn(async (...args: Parameters<typeof original>) => {
      await original(...args);
      const file = join(args[1], 'trial', 'result.json');
      const failed = JSON.parse(await readFile(file, 'utf8'));
      failed.qualification.api.failures = 1;
      await writeFile(file, JSON.stringify(failed));
    });
    const stopped = await runCampaign({ runsDir: dir, execute: true }, deps);
    expect(stopped.rows).toHaveLength(1);
    expect(stopped.stopped).toContain('API');
    await expect(runCampaign({ runsDir: dir, execute: true }, deps)).rejects.toThrow(
      'Campaign stopped',
    );
    expect(deps!.execute).toHaveBeenCalledTimes(1);
  });
  it('recovers a saved result after a process crash without paying for the cell again', async () => {
    const original = deps!.execute;
    deps!.execute = vi.fn(async (...args: Parameters<typeof original>) => {
      await original(...args);
      throw new Error('process crash');
    });
    await expect(runCampaign({ runsDir: dir, execute: true }, deps)).rejects.toThrow(
      'process crash',
    );
    deps!.execute = vi.fn((...args: Parameters<typeof original>) => original(...args));
    const resumed = await runCampaign({ runsDir: dir, execute: true }, deps);
    expect(deps!.execute).toHaveBeenCalledTimes(11);
    expect(resumed.rows).toHaveLength(12);
  });
  it('never repeats an ambiguous attempt without a saved result', async () => {
    deps!.execute = vi.fn(async () => {
      throw new Error('crash before finalization');
    });
    await expect(runCampaign({ runsDir: dir, execute: true }, deps)).rejects.toThrow(
      'crash before',
    );
    await expect(runCampaign({ runsDir: dir, execute: true }, deps)).rejects.toThrow(
      'will not be rerun automatically',
    );
    expect(deps!.execute).toHaveBeenCalledTimes(1);
  });
  it('preserves results and stops if source changes during a trial', async () => {
    let changed = false;
    const original = deps!.execute;
    deps!.identity = async () => ({ source: changed ? 'changed' : 'frozen' });
    deps!.execute = vi.fn(async (...args: Parameters<typeof original>) => {
      await original(...args);
      changed = true;
    });
    const stopped = await runCampaign({ runsDir: dir, execute: true }, deps);
    expect(stopped.stopped).toContain('changed during');
    expect(stopped.rows).toHaveLength(1);
    expect(deps!.execute).toHaveBeenCalledTimes(1);
  });
  it('does not launch after interruption and respects the directory lock', async () => {
    const controller = new AbortController();
    controller.abort();
    await runCampaign({ runsDir: dir, execute: true, signal: controller.signal }, deps);
    expect(deps!.execute).not.toHaveBeenCalled();
    await writeFile(join(dir, 'campaign.lock'), '{}');
    await expect(runCampaign({ runsDir: dir }, deps)).rejects.toThrow('locked');
  });
});
