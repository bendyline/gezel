import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { comparisonOptions } from '../bin/scorecard-campaign.ts';
import { repoRoot } from '../native-bin.ts';
import {
  type Cell,
  type Definition,
  comparisonArguments,
  comparisonCells,
  comparisonDefinition,
  trialEnvironment,
} from './plan.ts';
import { type Row, comparisonCsv, comparisonReport, eligible, median } from './report.ts';
import { readRow, runComparison } from './run.ts';

const configPath = join(repoRoot(), 'evals/campaigns/scorecard-six-providers.json');
async function fullDefinition() {
  return comparisonDefinition(JSON.parse(await readFile(configPath, 'utf8')), '/fixture-home');
}
async function smallDefinition(): Promise<Definition> {
  const d = await fullDefinition();
  return {
    ...d,
    count: 1,
    targets: d.targets.slice(0, 2),
    scenarios: d.scenarios.slice(0, 1),
    suites: ['core'],
  };
}
function row(cell: Cell, path: string): Row {
  return {
    cell,
    result: {
      trialId: cell.id,
      scenarioId: cell.scenario,
      modelId: cell.model,
      engine: cell.provider,
      generalistMode: 'on',
      repairPolicy: 'harness',
      success: true,
      reason: 'passed',
      durationMs: 1000,
      startedAt: '2026-10-11T00:00:00Z',
      finishedAt: '2026-10-11T00:00:01Z',
      runDir: path,
    },
    score: {
      trialId: cell.id,
      composite: 8,
      eligibility: { includedInModelAggregate: true, failureClass: 'none' },
    } as Row['score'],
    metrics: {
      usage: { available: true, totalInputTokens: 100, totalOutputTokens: 10 },
      derived: {
        durationMs: 1000,
        meanTokensPerSec: 110,
        genTokensPerSec: null,
        promptTokensPerSec: null,
        peakRssMb: null,
        peakGpuUtilPercent: null,
      },
    } as Row['metrics'],
    timing: {
      startedAt: '2026-10-11T00:00:00Z',
      finishedAt: '2026-10-11T00:00:01Z',
      timeToFirstToolCallMs: 100,
      timeToFirstArtifactMs: 500,
      timeToLastArtifactWriteMs: 500,
      timeToFirstTokenMs: null,
      firstTurnTtftMs: null,
    },
    toolCalls: 3,
    autoAnswers: 0,
    modes: undefined,
  };
}
const dirs: string[] = [];
async function directory() {
  const root = join(repoRoot(), 'evals/runs');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, '.comparison-test-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
function deps() {
  return {
    identity: vi.fn(async () => ({ source: 'frozen' })),
    execute: vi.fn(async () => 0),
    read: vi.fn(async (dir: string, cell: Cell) => row(cell, dir)),
    preflight: vi.fn(),
    log: vi.fn(),
  };
}

describe('mixed scorecard definition', () => {
  it('schedules all 774 distinct cells, including shared suite members', async () => {
    const d = await fullDefinition();
    const cells = comparisonCells(d);
    expect(d.scenarios).toHaveLength(43);
    expect(cells).toHaveLength(774);
    expect(new Set(cells.map((c) => c.id)).size).toBe(774);
    for (const s of d.scenarios)
      for (const t of d.targets)
        expect(
          cells.filter((c) => c.suite === s.suite && c.scenario === s.id && c.targetId === t.id),
        ).toHaveLength(3);
    expect(cells[0]!.targetId).not.toBe(cells[6]!.targetId);
  });
  it('keeps standard scenario semantics, admission and exact count', async () => {
    const d = await fullDefinition();
    const args = comparisonArguments(comparisonCells(d)[0]!, d, '/run', '/preflight');
    expect(args).toContain('--count-strict');
    expect(args).toContain('--no-triage');
    expect(args).toContain('--write-reports');
    for (const unwanted of [
      '--timeout',
      '--repair-policy',
      '--qualification',
      '--skip-preflight',
      '--llm-judge',
    ])
      expect(args).not.toContain(unwanted);
  });
  it('isolates CLI login credentials without modifying the parent environment or API arm', async () => {
    const d = await fullDefinition();
    const env = {
      OPENAI_API_KEY: 'fake-o',
      ANTHROPIC_API_KEY: 'fake-a',
      CODEX_API_KEY: 'fake-c',
      ANTHROPIC_AUTH_TOKEN: 'fake-t',
      CODEX_HOME: '/login',
    };
    expect(trialEnvironment(d, d.targets[0]!, env)).toEqual({
      CODEX_HOME: '/login',
      GEZEL_EVAL_REQUIRE_RUNTIME_LAYER: '1',
    });
    expect(trialEnvironment(d, d.targets[1]!, env)).toEqual({
      ...env,
      GEZEL_EVAL_REQUIRE_RUNTIME_LAYER: '1',
    });
    expect(trialEnvironment({ ...d, cliAuth: 'inherit' }, d.targets[0]!, env)).toEqual({
      ...env,
      GEZEL_EVAL_REQUIRE_RUNTIME_LAYER: '1',
    });
    expect(env.OPENAI_API_KEY).toBe('fake-o');
  });
  it('rejects unsafe target paths, duplicate targets and misspelled options', async () => {
    const d = await fullDefinition();
    const cfg = JSON.parse(await readFile(configPath, 'utf8'));
    expect(() =>
      comparisonDefinition({ ...cfg, targets: [{ ...cfg.targets[0], id: '../escape' }] }, '/home'),
    ).toThrow();
    expect(() =>
      comparisonDefinition({ ...cfg, targets: [cfg.targets[0], cfg.targets[0]] }, '/home'),
    ).toThrow('Duplicate');
    await expect(
      comparisonOptions(['--config', configPath, '--runs-dir', 'evals/runs/demo', '--limit']),
    ).rejects.toThrow('--limit');
    await expect(
      comparisonOptions([
        '--config',
        configPath,
        '--runs-dir',
        'evals/runs/demo',
        '--execute',
        'false',
      ]),
    ).rejects.toThrow('--execute');
    expect(d.targets[0]!.model).toBe(d.targets[1]!.model);
  });
});

describe('attempt journal', () => {
  it('prepares without auth or provider calls and resumes only pending attempts', async () => {
    const opts = { runsDir: await directory(), definition: await smallDefinition() };
    const dep = deps();
    expect((await runComparison(opts, dep)).rows).toHaveLength(0);
    expect(dep.preflight).not.toHaveBeenCalled();
    expect(dep.execute).not.toHaveBeenCalled();
    expect((await runComparison({ ...opts, execute: true, limit: 1 }, dep)).rows).toHaveLength(1);
    expect((await runComparison({ ...opts, execute: true }, dep)).rows).toHaveLength(2);
    await runComparison({ ...opts, execute: true }, dep);
    expect(dep.execute).toHaveBeenCalledTimes(2);
  });
  it('reconciles a saved result after interruption without repeating the paid call', async () => {
    const opts = {
      runsDir: await directory(),
      definition: await smallDefinition(),
      execute: true,
      limit: 1,
    };
    const dep = deps();
    dep.execute.mockRejectedValueOnce(new Error('process lost'));
    await expect(runComparison(opts, dep)).rejects.toThrow('process lost');
    const state = await runComparison({ ...opts, execute: false }, dep);
    expect(state.rows).toHaveLength(1);
    expect(state.running).toBeUndefined();
    expect(dep.execute).toHaveBeenCalledTimes(1);
  });
  it('never retries a partial attempt or an unjournaled directory', async () => {
    const opts = { runsDir: await directory(), definition: await smallDefinition(), execute: true };
    const dep = deps();
    dep.execute.mockResolvedValueOnce(2);
    await expect(runComparison(opts, dep)).rejects.toThrow('will not be retried');
    dep.read.mockRejectedValue(new Error('missing result'));
    await expect(runComparison(opts, dep)).rejects.toThrow('missing result');
    expect(dep.execute).toHaveBeenCalledTimes(1);
    const other = { ...opts, runsDir: await directory() };
    await mkdir(join(other.runsDir, comparisonCells(other.definition)[0]!.id));
    await expect(runComparison(other, deps())).rejects.toThrow();
  });
  it('continues ordinary task failures but stops infra failures', async () => {
    const opts = { runsDir: await directory(), definition: await smallDefinition(), execute: true };
    const dep = deps();
    dep.read.mockImplementation(async (dir, cell) => {
      const r = row(cell, dir);
      r.result.success = false;
      r.result.failureClass = cell.targetId === 'claude-cli' ? 'model' : 'infra';
      r.score.eligibility.includedInModelAggregate = r.result.failureClass !== 'infra';
      return r;
    });
    const state = await runComparison(opts, dep);
    expect(state.rows).toHaveLength(2);
    expect(state.stopped).toContain('infra');
  });
  it('records drift in the affected trial and stops before more spend', async () => {
    const opts = { runsDir: await directory(), definition: await smallDefinition(), execute: true };
    const dep = deps();
    dep.identity
      .mockResolvedValueOnce({ source: 'frozen' })
      .mockResolvedValueOnce({ source: 'frozen' })
      .mockResolvedValue({ source: 'changed' });
    const state = await runComparison(opts, dep);
    expect(dep.execute).toHaveBeenCalledTimes(1);
    expect(state.rows[0]!.comparisonIssue).toContain('source');
    expect(eligible(state.rows[0]!)).toBe(false);
    expect(dep.log).toHaveBeenCalledWith(
      expect.stringContaining('Stopped: Frozen comparison changed: source'),
    );
  });
  it('preserves an audited identity correction through resume without disabling the drift guard', async () => {
    const opts = {
      runsDir: await directory(),
      definition: await smallDefinition(),
      execute: true,
      limit: 1,
    };
    const dep = deps();
    await runComparison(opts, dep);
    const path = join(opts.runsDir, 'campaign.json');
    const state = JSON.parse(await readFile(path, 'utf8'));
    const correction = {
      at: '2026-10-11T00:00:00Z',
      reason: 'Verified bytecode-only false alarm',
      evidence: 'identity-recovery/audit.json',
    };
    state.identityCorrections = [correction];
    await writeFile(path, JSON.stringify(state));
    const resumed = await runComparison(opts, dep);
    expect(resumed.rows).toHaveLength(2);
    expect(dep.execute).toHaveBeenCalledTimes(2);
    expect(resumed.identityCorrections).toEqual([correction]);
    expect(
      JSON.parse(await readFile(join(opts.runsDir, 'summary.json'), 'utf8')).identityCorrections,
    ).toEqual([correction]);
    expect(await readFile(join(opts.runsDir, 'report.md'), 'utf8')).toContain(
      '[Audit evidence](<identity-recovery/audit.json>)',
    );
    dep.identity.mockResolvedValue({ source: 'changed' });
    await expect(runComparison(opts, dep)).rejects.toThrow('Frozen comparison changed');
    expect(dep.execute).toHaveBeenCalledTimes(2);
  });
  it('fails auth before journaling a trial and rejects changed definitions', async () => {
    const opts = { runsDir: await directory(), definition: await smallDefinition(), execute: true };
    const dep = deps();
    dep.preflight.mockImplementation(() => {
      throw new Error('no keys');
    });
    await expect(runComparison(opts, dep)).rejects.toThrow('no keys');
    expect(dep.execute).not.toHaveBeenCalled();
    expect(
      JSON.parse(await readFile(join(opts.runsDir, 'campaign.json'), 'utf8')).running,
    ).toBeUndefined();
    await expect(
      runComparison({ ...opts, definition: { ...opts.definition, count: 3 } }, deps()),
    ).rejects.toThrow('definition changed');
  });
  it('protects an active campaign with an exclusive lock', async () => {
    const opts = { runsDir: await directory(), definition: await smallDefinition() };
    await writeFile(join(opts.runsDir, 'campaign.lock'), 'occupied');
    await expect(runComparison(opts, deps())).rejects.toThrow('locked');
  });
});

describe('evidence and reporting', () => {
  it('reads one completed trial and rejects mismatched evidence', async () => {
    const d = await smallDefinition();
    const cell = comparisonCells(d)[0]!;
    const root = await directory();
    const dir = join(root, 'scenario', 'trial');
    await mkdir(dir, { recursive: true });
    const r = row(cell, dir);
    const write = async () => {
      await Promise.all(
        Object.entries({
          'result.json': r.result,
          'score.json': r.score,
          'metrics.json': r.metrics,
          'facts.json': {
            trialId: cell.id,
            timing: r.timing,
            toolUse: { totalToolCalls: 3 },
            autoAnswer: { total: 0 },
          },
        }).map(([name, value]) => writeFile(join(dir, name), JSON.stringify(value))),
      );
    };
    await write();
    expect((await readRow(root, cell, d)).toolCalls).toBe(3);
    await writeFile(join(dir, 'status.json'), '{}');
    await expect(readRow(root, cell, d)).rejects.toThrow('active status');
    await rm(join(dir, 'status.json'));
    r.result.engine = 'openai';
    await write();
    await expect(readRow(root, cell, d)).rejects.toThrow('mismatch');
  });
  it('preserves missing performance, excludes infrastructure and distinguishes suite repeats', async () => {
    const d = await fullDefinition();
    const cells = comparisonCells(d);
    const r = row(cells[0]!, '/result');
    const report = comparisonReport(d, cells, [r]);
    expect(report).toContain('1/774 trials recorded');
    expect(report).not.toContain('110.0'); // Whole-trial token throughput is not decode speed.
    expect(report).toContain('—');
    expect(report).toContain(
      'Natural lifecycle completion and independent API qualification are not measured',
    );
    expect(comparisonCsv([r])).toContain('decodeTokensPerSec');
    expect(median([null, 1, 3, undefined])).toBe(2);
    r.score.eligibility.includedInModelAggregate = false;
    expect(eligible(r)).toBe(false);
  });
});
