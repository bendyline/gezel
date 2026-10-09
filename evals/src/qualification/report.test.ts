import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { score } from '../bin/score-trial.ts';
import { classifyTrial } from '../failure-class.ts';
import { writeTrialReport } from '../postmortem-report.ts';
import { writeQualificationReport } from './report.ts';

describe('qualification report', () => {
  let dir: string;
  const save = (name: string, value: unknown) => writeFile(join(dir, name), JSON.stringify(value));
  const request = {
    phase: 'request',
    requestId: 'r1',
    sessionId: 's1',
    provider: 'openai',
    model: 'model-a',
    tools: { count: 1, schemaHash: 'hash' },
  };
  const result = {
    phase: 'result',
    requestId: 'r1',
    provider: 'openai',
    model: 'model-a',
    outcome: 'completed',
    toolCalls: 1,
    usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: null },
  };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qualification-report-'));
    await mkdir(join(dir, 'sessions'));
    await save('measurement.json', {
      unavailable: [],
      treatment: {
        provider: 'openai',
        model: 'model-a',
        repairPolicy: 'runtime',
        qualification: { userSimulation: 'disabled' },
      },
    });
    await save('sessions/s1.json', {
      id: 's1',
      providerName: 'openai',
      messages: [{ role: 'assistant' }],
    });
    await save('lifecycle.json', { status: 'complete' });
    await writeFile(
      join(dir, 'daemon.log'),
      [request, result].map((r) => `INFO measurement.api ${JSON.stringify(r)}`).join('\n'),
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  it('qualifies observed completion, keeping missing usage unknown', async () => {
    const report = await writeQualificationReport(dir, true);
    expect(report).toMatchObject({
      passed: true,
      artifactSuccess: true,
      independence: 'observed',
      api: {
        requests: 1,
        toolRounds: 1,
        sdkRetries: null,
        usage: { inputTokens: 100, reasoningTokens: null },
      },
    });
    expect(JSON.parse(await readFile(join(dir, 'qualification.json'), 'utf8'))).toEqual(report);
  });
  it('separates a valid artifact from an incomplete task lifecycle', async () => {
    await save('lifecycle.json', { status: 'incomplete' });
    expect(await writeQualificationReport(dir, true)).toMatchObject({
      passed: false,
      artifactSuccess: true,
    });
  });

  it('preserves qualification in scored facts and the generated postmortem', async () => {
    const qualification = await writeQualificationReport(dir, true);
    await save('result.json', {
      trialId: 'qualification-test',
      scenarioId: 'test',
      modelId: 'model-a',
      success: true,
      reason: 'passed',
      durationMs: 1000,
      startedAt: '2026-10-09T00:00:00Z',
      finishedAt: '2026-10-09T00:00:01Z',
      qualification,
      repairPolicy: 'runtime',
    });
    const facts = score(dir);
    expect(facts.qualification).toEqual(qualification);
    expect(facts.repairPolicy).toBe('runtime');
    await save('facts.json', facts);
    expect((await writeTrialReport(dir)).status).toBe('written');
    expect(await readFile(join(dir, 'postmortem.md'), 'utf8')).toContain(
      'API harness qualification',
    );
  });

  it('does not attribute broken qualification evidence to model capability', () => {
    for (const reason of [
      'Qualification failed: API request provenance is incomplete',
      'Qualification blocked an undeclared evaluator mutation',
      'runner crashed: Qualification blocked provider codex-cli; expected openai',
    ]) {
      expect(classifyTrial({ success: false, reason })).toMatchObject({
        failureClass: 'grader',
        rule: 'qualification-evidence',
      });
    }
    expect(
      classifyTrial({
        success: false,
        reason: 'interrupted (SIGINT/SIGTERM) during qualification completion wait',
        failureMode: 'interrupted',
      }).failureClass,
    ).toBe('operator');
  });
  it('detects mixed helpers even when the visible worker uses the expected provider', async () => {
    await writeFile(
      join(dir, 'daemon.log'),
      [
        request,
        result,
        { ...request, requestId: 'helper', sessionId: undefined, model: 'fallback-model' },
      ]
        .map((r) => `measurement.api ${JSON.stringify(r)}`)
        .join('\n'),
    );
    expect(await writeQualificationReport(dir, true)).toMatchObject({
      passed: false,
      independence: 'mixed',
      api: { incomplete: 1 },
    });
  });
  it('rejects hidden evaluator repairs and recognizes assisted diagnostics', async () => {
    await writeFile(
      join(dir, 'interventions.jsonl'),
      JSON.stringify({ source: 'evaluator', status: 'blocked' }),
    );
    expect((await writeQualificationReport(dir, true))?.issues).toContain(
      'undeclared evaluator mutation was blocked',
    );
    await writeFile(
      join(dir, 'interventions.jsonl'),
      JSON.stringify({ source: 'evaluator', status: 'delivered' }),
    );
    expect(await writeQualificationReport(dir, true)).toMatchObject({
      passed: false,
      independence: 'assisted',
    });
  });
  it.each([
    { name: 'run_command', argsFull: 'codex exec fix-it', success: false },
    { name: 'run_script', argsFull: 'subprocess.run(["claude", "fix-it"])', success: false },
  ])('detects CLI execution in $name and counts tool failures', async (call) => {
    await save('sessions/s1.json', {
      id: 's1',
      providerName: 'openai',
      messages: [
        {
          role: 'assistant',
          toolCalls: [call],
        },
      ],
    });
    expect(await writeQualificationReport(dir, true)).toMatchObject({
      passed: false,
      independence: 'mixed',
      toolFailures: 1,
    });
  });
  it('fails closed on corrupt or absent session evidence, without crashing finalization', async () => {
    await writeFile(join(dir, 'sessions/s1.json'), '{');
    expect(await writeQualificationReport(dir, true)).toMatchObject({
      passed: false,
      independence: 'unobservable',
    });
    await writeFile(join(dir, 'measurement.json'), '{');
    expect((await writeQualificationReport(dir, true))?.passed).toBe(false);
  });
});
