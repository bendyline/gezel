import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { dataWrangleScenario } from '../scenarios/data-wrangle.ts';
import {
  androidInstrumentationCommand,
  instrumentationSucceeded,
  requireAndroidStagingSpace,
} from './android-runner.ts';
import { requireMobileBuildIdentity } from './build-identity.ts';
import { mobileEvalClockSource } from './clock.ts';
import { canonicalMobileFixtures } from './fixtures.ts';
import { type MobileReport, mobileTrialFacts, writeMobileEvaluationReport } from './report.ts';

describe('native mobile eval boundary', () => {
  it('requires both the current packaged product and test-source digests before crediting native results', () => {
    const expected = { harnessSourceSha256: 'a'.repeat(64), productIndexSha256: 'b'.repeat(64) };
    expect(() => requireMobileBuildIdentity({ ...expected }, expected)).not.toThrow();
    for (const key of ['harnessSourceSha256', 'productIndexSha256'] as const) {
      expect(() =>
        requireMobileBuildIdentity({ ...expected, [key]: 'c'.repeat(64) }, expected),
      ).toThrow('does not prove current build coverage');
      expect(() => requireMobileBuildIdentity({ ...expected, [key]: undefined }, expected)).toThrow(
        'does not prove current build coverage',
      );
    }
  });

  it('uses the unchanged shared AwakeBudget to exclude suspension from native trial budgets', async () => {
    let wall = 1000;
    const context = {
      globalThis: {},
      Date: { now: () => wall },
      setInterval: () => ({}),
      clearInterval: () => {},
    };
    const source = await mobileEvalClockSource();
    expect(
      await readFile(
        new URL('../../../packages/mobile/evals/mobile-eval-clock.js', import.meta.url),
        'utf8',
      ),
    ).toBe(source);
    runInNewContext(source, context);
    const clock = (
      context.globalThis as {
        __gezelMobileEvalClock: {
          startSuspendMonitor(): void;
          stopSuspendMonitor(): void;
          AwakeBudget: new (
            milliseconds: number,
          ) => { remainingMs(): number; suspendedMs(): number; expired(): boolean };
        };
      }
    ).__gezelMobileEvalClock;
    clock.startSuspendMonitor();
    const budget = new clock.AwakeBudget(60000);
    wall += 1000;
    expect(budget.remainingMs()).toBe(59000);
    wall += 30000;
    expect(budget.remainingMs()).toBe(57000);
    expect(budget.suspendedMs()).toBe(28000);
    expect(budget.expired()).toBe(false);
    clock.stopSuspendMonitor();
  });
  it('reserves both trained-model copies before staging and rejects unreadable disk accounting', () => {
    const df =
      'Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/data 10000000 1000000 9000000 10% /data';
    expect(() => requireAndroidStagingSpace(df, 4_215_695_776)).not.toThrow();
    expect(() =>
      requireAndroidStagingSpace(df.replace('9000000', '6000000'), 4_215_695_776),
    ).toThrow('free bytes');
    expect(() => requireAndroidStagingSpace('permission denied', 10)).toThrow('free bytes');
  });

  it('runs Android instrumentation without delegating uninstall and rejects adb false success', () => {
    const command = androidInstrumentationCommand({ evalRunId: "trial'$(false); value" });
    expect(command).toContain("'trial'\\''$(false); value'");
    expect(command).not.toContain('uninstall');
    expect(
      instrumentationSucceeded({ code: 0, stdout: 'OK (1 test)\nINSTRUMENTATION_CODE: -1' }),
    ).toBe(true);
    for (const stdout of [
      'FAILURES!!!\nINSTRUMENTATION_CODE: -1',
      'OK (1 test)',
      'OK (1 test)\nINSTRUMENTATION_CODE: -1\nshortMsg=Process crashed',
    ])
      expect(instrumentationSucceeded({ code: 0, stdout })).toBe(false);
    expect(
      instrumentationSucceeded({ code: 1, stdout: 'OK (1 test)\nINSTRUMENTATION_CODE: -1' }),
    ).toBe(false);
  });

  it('requires original native product restoration in addition to passing contracts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gezel-mobile-restoration-'));
    try {
      const report: MobileReport = {
        schemaVersion: 1,
        runId: 'restoration',
        suite: 'mobile-contracts',
        complete: true,
        startedAt: new Date().toISOString(),
        identity: { os: 'Android' },
        trials: [],
        canonicalCoreCoverage: [],
        contracts: { passed: true },
        reopen: { passed: true, checks: [] },
      };
      expect((await writeMobileEvaluationReport(report, directory)).success).toBe(false);
      report.nativeRestoration = { passed: true, productFiles: 3, modelInventoryFiles: 3 };
      expect((await writeMobileEvaluationReport(report, directory)).success).toBe(true);
      report.identity.os = 'iOS';
      expect((await writeMobileEvaluationReport(report, directory)).success).toBe(true);
      delete report.nativeRestoration;
      expect((await writeMobileEvaluationReport(report, directory)).success).toBe(false);
      const markdown = await readFile(join(directory, 'report.md'), 'utf8');
      expect(markdown).toContain('Deterministic provider completions');
      expect(markdown).toContain('not a model quality result');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('captures unchanged canonical setup and budgets without a model or fixture fork', async () => {
    const fixtures = await canonicalMobileFixtures();
    const checkedIn = JSON.parse(
      await readFile(
        new URL('../../../packages/mobile/evals/canonical-fixtures.json', import.meta.url),
        'utf8',
      ),
    );
    expect(fixtures).toEqual(checkedIn);
    expect(fixtures.map((f) => f.id)).toEqual([
      'incident-postmortem',
      'conflict-synthesis',
      'data-wrangle',
      'tictactoe',
      'tankcombat',
      'schema-migration',
      'failing-tests-spec',
      'symptom-debug',
      'ops-runbook-anomaly',
      'plan-and-estimate',
    ]);
    expect(fixtures.every((f) => f.timeoutMs >= 20 * 60_000 && f.prompts.length > 0)).toBe(true);
  });

  it('never falls through to real inference and restores the provider boundary after cleanup errors', async () => {
    const source = await readFile(
      new URL('../../../packages/mobile/evals/mobile-product-eval.js', import.meta.url),
      'utf8',
    );
    const original = vi.fn(async (_plugin: string, _method: string, _options: unknown) => ({
      text: 'real provider must not be called',
    }));
    const capacitor = { getPlatform: () => 'android', nativePromise: original };
    let intercepted = false;
    const context = {
      window: {
        Capacitor: capacitor,
        __GEZEL__: {
          baseUrl: 'https://gezel.local',
          token: 'test',
          fetch: async () => {
            if (!intercepted) {
              intercepted = true;
              await expect(capacitor.nativePromise('GezelMobile', 'generate', {})).rejects.toThrow(
                'Unexpected contract generation',
              );
            }
            return new Response(JSON.stringify({ error: 'contract transport failure' }), {
              status: 503,
            });
          },
        },
      },
      globalThis: {},
      Request,
      setTimeout,
    };
    runInNewContext(`${await mobileEvalClockSource()}\n${source}`, context);
    const harness = (
      context.globalThis as {
        __gezelMobileEval?: {
          productMechanicsContracts(result: unknown, recipient: unknown): Promise<void>;
        };
      }
    ).__gezelMobileEval!;
    const result = { projectId: 'default', assertions: [] as Array<{ passed: boolean }> };
    await expect(harness.productMechanicsContracts(result, { id: 'companion' })).rejects.toThrow(
      'contract transport failure',
    );
    expect(result.assertions.some((item) => !item.passed)).toBe(true);
    expect(intercepted).toBe(true);
    expect(capacitor.nativePromise).toBe(original);
    expect(original).not.toHaveBeenCalled();
  });

  it('refuses browser-only inference and reports unavailable native models as blocked', async () => {
    const source = await readFile(
      new URL('../../../packages/mobile/evals/mobile-product-eval.js', import.meta.url),
      'utf8',
    );
    const context = {
      window: { Capacitor: { isNativePlatform: () => false } },
      globalThis: {},
      navigator: { userAgent: 'test' },
      setTimeout,
    };
    runInNewContext(`${await mobileEvalClockSource()}\n${source}`, context);
    const harness = (
      context.globalThis as { __gezelMobileEval?: { run(options: unknown): Promise<MobileReport> } }
    ).__gezelMobileEval!;
    await expect(harness.run({ provider: 'apple-foundation-models' })).rejects.toThrow(
      'packaged native',
    );
    Object.assign(context.window.Capacitor, {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      Plugins: {
        GezelMobile: {
          providers: async () => ({
            providers: [
              {
                id: 'apple-foundation-models',
                availability: 'unavailable',
                reason: 'Model unavailable',
              },
            ],
          }),
          listModels: async () => ({ models: [] }),
        },
      },
    });
    const report = await harness.run({
      provider: 'apple-foundation-models',
      runId: 'contract',
      identity: {},
    });
    expect(report.complete).toBe(true);
    expect(report.trials).toHaveLength(7);
    expect(report.trials.every((t) => t.status === 'blocked')).toBe(true);
    expect(report.canonicalCoreCoverage.some((c) => c.status === 'pass')).toBe(false);
  });

  it('keeps unavailable, failed, and missing persistence evidence out of passing counts', async () => {
    const output = await mkdtemp(join(tmpdir(), 'gezel-mobile-report-'));
    try {
      const report: MobileReport = {
        schemaVersion: 1,
        runId: 'contract',
        suite: 'mobile-product-v1',
        complete: true,
        startedAt: '2026-09-20T00:00:00Z',
        finishedAt: '2026-09-20T00:00:01Z',
        identity: {
          provider: { id: 'apple-foundation-models' },
          model: { id: 'apple-foundation-models' },
        },
        trials: [
          {
            id: 'text-artifact',
            status: 'blocked',
            error: 'Model unavailable',
            assertions: [],
            sessions: [],
            artifacts: [],
          },
        ],
        canonicalCoreCoverage: [
          { id: 'petshop', status: 'unsupported', requirement: 'Native image generation' },
        ],
      };
      const result = await writeMobileEvaluationReport(report, output);
      expect(result.success).toBe(false);
      const score = JSON.parse(await readFile(join(output, 'text-artifact/score.json'), 'utf8'));
      expect(score.eligibility).toMatchObject({
        failureClass: 'infra',
        includedInModelAggregate: false,
      });
      expect(mobileTrialFacts(report, report.trials[0]!, output).outcome.success).toBe(false);
      expect(result.summary).toContain('unsupported');
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  it('cannot promote unfinished native work, missing reload evidence, or preexisting files', async () => {
    const output = await mkdtemp(join(tmpdir(), 'gezel-mobile-scoring-'));
    const fixture = (await canonicalMobileFixtures()).find((entry) => entry.id === 'data-wrangle')!;
    // A synthetic verdict tests adapter admission only; it is never a model-quality trial.
    const grader = vi.spyOn(dataWrangleScenario, 'successCheck');
    try {
      for (const reason of ['unfinished', 'missing-reload', 'preexisting'] as const) {
        const artifact = {
          projectId: 'default',
          area: 'workspace',
          path: 'prior.json',
          content: 'old output',
        };
        const report: MobileReport = {
          schemaVersion: 1,
          runId: reason,
          suite: 'mobile-product-v1',
          complete: true,
          startedAt: '2026-09-20T00:00:00Z',
          finishedAt: '2026-09-20T00:00:02Z',
          identity: { provider: { id: 'contract-provider' } },
          contracts: { passed: true },
          canonicalCoreCoverage: [
            { id: fixture.id, status: 'not-run', requirement: 'canonical adapter' },
          ],
          reopen: {
            passed: true,
            checks:
              reason === 'missing-reload' ? [] : [{ id: `${fixture.id}:prior.json`, passed: true }],
          },
          trials: [
            {
              id: fixture.id,
              suite: 'canonical-core-first-attempt',
              status: reason === 'unfinished' ? 'running' : 'ungraded',
              ...(reason === 'unfinished' ? {} : { finishedAt: '2026-09-20T00:00:02Z' }),
              assertions: [
                { id: 'native-inference-observed', passed: true },
                { id: 'no-provider-error', passed: true },
              ],
              sessions: [],
              artifacts: [artifact],
              ...(reason === 'preexisting' ? { preexistingArtifacts: [artifact] } : {}),
              canonicalFixture: {
                id: fixture.id,
                sourceSha256: fixture.sourceSha256,
                output: fixture.output,
              },
            },
          ],
        };
        grader.mockImplementation(async (context) => {
          const files = await context.client.listProjectWorkspace('default');
          return {
            done: true,
            success: files.files.length > 0,
            reason: 'Adapter admission contract',
          };
        });
        const result = await writeMobileEvaluationReport(report, join(output, reason));
        expect(result.success).toBe(false);
        expect(report.trials[0]?.status).toBe('fail');
      }
    } finally {
      grader.mockRestore();
      await rm(output, { recursive: true, force: true });
    }
  });

  it('merges independent native phase evidence without rechecking overwritten trial paths', async () => {
    const source = await readFile(
      new URL('../../../packages/mobile/evals/mobile-product-eval.js', import.meta.url),
      'utf8',
    );
    const context = { globalThis: {}, setTimeout };
    runInNewContext(`${await mobileEvalClockSource()}\n${source}`, context);
    const harness = (
      context.globalThis as {
        __gezelMobileEval: { mergeReports(reports: unknown[], complete?: boolean): MobileReport };
      }
    ).__gezelMobileEval;
    const phase = (id: string) => ({
      suite: 'mobile-product-v1',
      complete: true,
      trials: [{ id }],
      canonicalCoreCoverage: [],
      reopen: { passed: true, checks: [{ id: `${id}:index.html`, passed: true }] },
    });
    const phases = [phase('first'), phase('second')];
    expect(harness.mergeReports(phases).complete).toBe(false);
    const merged = harness.mergeReports(phases, true);
    expect(merged.complete).toBe(true);
    expect(merged.trials.map((trial) => trial.id)).toEqual(['first', 'second']);
    expect(merged.reopen?.checks.map((check) => check.id)).toEqual([
      'first:index.html',
      'second:index.html',
    ]);
    phases[0]!.reopen.passed = false;
    expect(harness.mergeReports(phases, true).reopen?.passed).toBe(false);
  });
});
