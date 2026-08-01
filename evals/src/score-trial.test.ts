import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { score } from './bin/score-trial.ts';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'gezel-score-trial-test-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe('score-trial project history fallback', () => {
  it('counts project-history tool calls when session dumps undercount them', async () => {
    await mkdir(join(tempRoot, 'sessions'), { recursive: true });
    await mkdir(join(tempRoot, 'project-history'), { recursive: true });
    await mkdir(join(tempRoot, 'workspace', 'demo'), { recursive: true });

    await writeFile(
      join(tempRoot, 'result.json'),
      JSON.stringify({
        trialId: 'demo-trial',
        scenarioId: 'bookstore-openapi',
        modelId: 'qwen3.6-27b-q8',
        startedAt: '2026-06-04T00:00:00.000Z',
        finishedAt: '2026-06-04T00:00:10.000Z',
        durationMs: 10_000,
        success: true,
        reason: 'ok',
      }),
    );
    await writeFile(
      join(tempRoot, 'log.txt'),
      '[2026-06-04T00:00:00.000Z] [poll] starting (interval=5000ms maxDuration=100000ms)\n',
    );
    await writeFile(
      join(tempRoot, 'history.jsonl'),
      `${JSON.stringify({
        at: '2026-06-04T00:00:00.000Z',
        kind: 'gezel.created',
        details: { role: 'Developer' },
      })}\n`,
    );
    await writeFile(
      join(tempRoot, 'sessions', 'sam--session.json'),
      JSON.stringify({
        messages: [{ role: 'user', content: 'work', at: '2026-06-04T00:00:01.000Z' }],
      }),
    );
    await writeFile(
      join(tempRoot, 'project-history', 'demo.jsonl'),
      [
        {
          at: '2026-06-04T00:00:02.000Z',
          kind: 'workspace.write',
          details: { path: 'seed.md', bytes: 12 },
        },
        {
          at: '2026-06-04T00:00:04.000Z',
          kind: 'tool.called',
          gezelId: 'sam',
          details: { name: 'read_file', durationMs: 2, success: true },
        },
        {
          at: '2026-06-04T00:00:07.000Z',
          kind: 'workspace.write',
          gezelId: 'sam',
          details: { path: 'postmortem.md', bytes: 4096 },
        },
        {
          at: '2026-06-04T00:00:07.010Z',
          kind: 'tool.called',
          gezelId: 'sam',
          details: { name: 'write_file', durationMs: 10, success: true },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
    );

    const facts = score(tempRoot);

    expect(facts.toolUse.totalToolCalls).toBe(2);
    expect(facts.toolUse.byTool).toEqual({ read_file: 1, write_file: 1 });
    expect(facts.timing.timeToFirstArtifactMs).toBe(7_000);
    expect(facts.timing.timeToLastArtifactWriteMs).toBe(7_000);
  });

  it('copies native-engine reliability facts from result.json', async () => {
    await mkdir(join(tempRoot, 'sessions'), { recursive: true });
    await writeFile(
      join(tempRoot, 'result.json'),
      JSON.stringify({
        trialId: 'native-recovery',
        scenarioId: 'bookstore-openapi',
        modelId: 'qwen3.6-27b-q8',
        startedAt: '2026-06-04T00:00:00.000Z',
        finishedAt: '2026-06-04T00:00:10.000Z',
        durationMs: 10_000,
        success: true,
        reason: 'ok after restart',
        nativeEngineIncidents: {
          count: 1,
          kinds: { 'cuda-invalid-argument': 1 },
          incidentIds: ['native-55121-1234'],
          evidence: ['CUDA error: invalid argument'],
        },
      }),
    );

    expect(score(tempRoot).nativeEngineIncidents).toEqual({
      count: 1,
      kinds: { 'cuda-invalid-argument': 1 },
      incidentIds: ['native-55121-1234'],
      evidence: ['CUDA error: invalid argument'],
    });
  });
});

describe('score-trial F4.1 latency timing', () => {
  it('derives time-to-first-token from the daemon log and time-to-first-tool-call from the transcript', async () => {
    await mkdir(join(tempRoot, 'sessions'), { recursive: true });
    await writeFile(
      join(tempRoot, 'result.json'),
      JSON.stringify({
        trialId: 'ttft-trial',
        scenarioId: 'tictactoe',
        modelId: 'gemma4-e4b-q8',
        startedAt: '2026-06-04T00:00:00.000Z',
        finishedAt: '2026-06-04T00:00:10.000Z',
        durationMs: 10_000,
        success: true,
        reason: 'ok',
      }),
    );
    // First TTFT line lands 2.5s in and reports a 1500ms first-token latency;
    // a second (later) line must NOT override the first.
    await writeFile(
      join(tempRoot, 'daemon.log'),
      [
        '2026-06-04T00:00:00.100Z INFO  [chat] booting',
        '2026-06-04T00:00:02.500Z INFO  [llama-cpp] [llama-cpp] TTFT 1500ms (session model=llama-cpp)',
        '2026-06-04T00:00:06.000Z INFO  [llama-cpp] [llama-cpp] TTFT 40ms (session model=llama-cpp)',
      ].join('\n'),
    );
    // A tool call at 3.0s (after first token) — the agent's first ACTION.
    await writeFile(
      join(tempRoot, 'sessions', 'dev--session.json'),
      JSON.stringify({
        messages: [
          { role: 'user', content: 'build it', at: '2026-06-04T00:00:00.200Z' },
          {
            role: 'assistant',
            content: 'writing',
            at: '2026-06-04T00:00:03.000Z',
            toolCalls: [{ name: 'write_file', success: true, argsSummary: 'path: "x.html"' }],
          },
        ],
      }),
    );

    const facts = score(tempRoot);

    expect(facts.timing.timeToFirstTokenMs).toBe(2_500);
    expect(facts.timing.firstTurnTtftMs).toBe(1_500);
    expect(facts.timing.timeToFirstToolCallMs).toBe(3_000);
  });

  it('leaves token timing null when the daemon log has no TTFT line (cloud/CLI provider)', async () => {
    await mkdir(join(tempRoot, 'sessions'), { recursive: true });
    await writeFile(
      join(tempRoot, 'result.json'),
      JSON.stringify({
        trialId: 'cloud-trial',
        scenarioId: 'tictactoe',
        modelId: 'gpt-5',
        startedAt: '2026-06-04T00:00:00.000Z',
        finishedAt: '2026-06-04T00:00:05.000Z',
        durationMs: 5_000,
        success: true,
        reason: 'ok',
      }),
    );

    const facts = score(tempRoot);

    expect(facts.timing.timeToFirstTokenMs).toBeNull();
    expect(facts.timing.firstTurnTtftMs).toBeNull();
    expect(facts.timing.timeToFirstToolCallMs).toBeNull();
  });
});

describe('score-trial expected role matching', () => {
  it('accepts descriptive role titles that include the expected role slug', async () => {
    await mkdir(join(tempRoot, 'sessions'), { recursive: true });
    await mkdir(join(tempRoot, 'workspace'), { recursive: true });

    await writeFile(
      join(tempRoot, 'result.json'),
      JSON.stringify({
        trialId: 'petshop-trial',
        scenarioId: 'petshop',
        modelId: 'gpt-5.5',
        startedAt: '2026-06-26T00:00:00.000Z',
        finishedAt: '2026-06-26T00:00:10.000Z',
        durationMs: 10_000,
        success: true,
        reason: 'ok',
      }),
    );
    await writeFile(
      join(tempRoot, 'log.txt'),
      '[2026-06-26T00:00:00.000Z] [poll] starting (interval=5000ms maxDuration=100000ms)\n',
    );
    await writeFile(
      join(tempRoot, 'history.jsonl'),
      [
        {
          at: '2026-06-26T00:00:00.000Z',
          kind: 'gezel.created',
          details: { role: 'image-generator for AI-created PNG logo' },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
    );

    const facts = score(tempRoot);

    expect(facts.team.rolesCreated).toContain('image-generator for AI-created PNG logo');
    expect(facts.team.missingExpectedRoles).toEqual([]);
  });
});

describe('score-trial sniff parsing', () => {
  it('extracts scenario signals from log lines that do not include an explicit score', async () => {
    await mkdir(join(tempRoot, 'workspace'), { recursive: true });
    await mkdir(join(tempRoot, 'sessions'), { recursive: true });

    await writeFile(
      join(tempRoot, 'result.json'),
      JSON.stringify({
        trialId: 'self-correction-trial',
        scenarioId: 'self-correction-broken-js',
        modelId: 'llama3.2',
        startedAt: '2026-06-04T00:00:00.000Z',
        finishedAt: '2026-06-04T00:00:20.000Z',
        durationMs: 20_000,
        success: true,
        reason:
          'JS now parses + intent preserved (signals: script-closed, js-parses, js-non-trivial, preserves-intent)',
      }),
    );
    await writeFile(
      join(tempRoot, 'log.txt'),
      [
        '[2026-06-04T00:00:00.000Z] [poll] starting (interval=5000ms maxDuration=720000ms)',
        '[2026-06-04T00:00:10.000Z] [scenario] index.html bytes=541 signals=script-closed,js-parses,js-non-trivial,preserves-intent',
      ].join('\n'),
    );
    await writeFile(join(tempRoot, 'history.jsonl'), '');
    await writeFile(join(tempRoot, 'workspace', 'index.html'), '<!doctype html><script></script>');

    const facts = score(tempRoot);

    expect(facts.sniff.latest).toEqual({
      filePath: 'index.html',
      bytes: 541,
      score: 4,
      scoreMax: null,
      signals: ['script-closed', 'js-parses', 'js-non-trivial', 'preserves-intent'],
      failReason: null,
    });
    expect(facts.sniff.progression).toHaveLength(1);
  });

  it('extracts fail reasons from scoreless scenario signal lines', async () => {
    await mkdir(join(tempRoot, 'workspace'), { recursive: true });

    await writeFile(
      join(tempRoot, 'result.json'),
      JSON.stringify({
        trialId: 'self-correction-trial',
        scenarioId: 'self-correction-broken-js',
        modelId: 'llama3.2',
        startedAt: '2026-06-04T00:00:00.000Z',
        finishedAt: '2026-06-04T00:00:20.000Z',
        durationMs: 20_000,
        success: false,
        reason: 'timeout',
      }),
    );
    await writeFile(
      join(tempRoot, 'log.txt'),
      [
        '[2026-06-04T00:00:00.000Z] [poll] starting (interval=5000ms maxDuration=720000ms)',
        '[2026-06-04T00:00:10.000Z] [scenario] index.html bytes=477 signals=script-closed failReason="inline JS still does not parse (Unexpected end of input)"',
      ].join('\n'),
    );
    await writeFile(join(tempRoot, 'history.jsonl'), '');

    const facts = score(tempRoot);

    expect(facts.sniff.latest).toEqual({
      filePath: 'index.html',
      bytes: 477,
      score: 1,
      scoreMax: null,
      signals: ['script-closed'],
      failReason: 'inline JS still does not parse (Unexpected end of input)',
    });
  });

  it('extracts fraction scores and fail reasons after extra scenario metadata', async () => {
    await mkdir(join(tempRoot, 'workspace'), { recursive: true });

    await writeFile(
      join(tempRoot, 'result.json'),
      JSON.stringify({
        trialId: 'review-trial',
        scenarioId: 'squisq-review',
        modelId: 'qwen3.6-27b-q4',
        startedAt: '2026-06-04T00:00:00.000Z',
        finishedAt: '2026-06-04T00:00:20.000Z',
        durationMs: 20_000,
        success: false,
        reason: 'timeout',
      }),
    );
    await writeFile(
      join(tempRoot, 'log.txt'),
      [
        '[2026-06-04T00:00:00.000Z] [poll] starting (interval=5000ms maxDuration=720000ms)',
        '[2026-06-04T00:00:10.000Z] [scenario] review.md bytes=5965 score=5/7 signals=has-title,has-findings citations=1 failReason="needs two source citations"',
      ].join('\n'),
    );
    await writeFile(join(tempRoot, 'history.jsonl'), '');

    const facts = score(tempRoot);

    expect(facts.sniff.latest).toEqual({
      filePath: 'review.md',
      bytes: 5965,
      score: 5,
      scoreMax: 7,
      signals: ['has-title', 'has-findings'],
      failReason: 'needs two source citations',
    });
  });

  it('extracts bytes from generic craftbook check lines', async () => {
    await mkdir(join(tempRoot, 'workspace'), { recursive: true });

    await writeFile(
      join(tempRoot, 'result.json'),
      JSON.stringify({
        trialId: 'craftbook-trial',
        scenarioId: 'craftbook-press-release',
        modelId: 'gemma4-e4b-q8',
        startedAt: '2026-06-28T00:00:00.000Z',
        finishedAt: '2026-06-28T00:02:00.000Z',
        durationMs: 120_000,
        success: false,
        reason: 'model stuck',
      }),
    );
    await writeFile(
      join(tempRoot, 'log.txt'),
      [
        '[2026-06-28T00:00:00.000Z] [poll] starting (interval=5000ms maxDuration=720000ms)',
        '[2026-06-28T00:01:00.000Z] [scenario] craftbook-press-release bytes=1516 checks=15/16 failures=press-release.md has unsupported claim wording',
      ].join('\n'),
    );
    await writeFile(join(tempRoot, 'history.jsonl'), '');

    const facts = score(tempRoot);

    expect(facts.sniff.latest).toEqual({
      filePath: 'craftbook-press-release',
      bytes: 1516,
      score: 15,
      scoreMax: 16,
      signals: [],
      failReason: 'press-release.md has unsupported claim wording',
    });
  });

  it('extracts phased scenario metadata before bytes', async () => {
    await mkdir(join(tempRoot, 'workspace'), { recursive: true });

    await writeFile(
      join(tempRoot, 'result.json'),
      JSON.stringify({
        trialId: 'codebase-trial',
        scenarioId: 'codebase-evolution',
        modelId: 'gemma4-e4b-q8',
        startedAt: '2026-06-04T00:00:00.000Z',
        finishedAt: '2026-06-04T00:00:20.000Z',
        durationMs: 20_000,
        success: false,
        reason: 'retry loop',
      }),
    );
    await writeFile(
      join(tempRoot, 'log.txt'),
      [
        '[2026-06-04T00:00:00.000Z] [poll] starting (interval=5000ms maxDuration=720000ms)',
        '[2026-06-04T00:00:10.000Z] [scenario] codebase-evolution phase=4 bytes=15570 score=18/19 signals=module-script,src-state-module failReason="module-imports-exports: The refactor must use real ES module imports/exports."',
      ].join('\n'),
    );
    await writeFile(join(tempRoot, 'history.jsonl'), '');

    const facts = score(tempRoot);

    expect(facts.sniff.latest).toEqual({
      filePath: 'codebase-evolution',
      bytes: 15570,
      score: 18,
      scoreMax: 19,
      signals: ['module-script', 'src-state-module'],
      failReason: 'module-imports-exports: The refactor must use real ES module imports/exports.',
    });
  });

  it('parses a mission-criteria gate line with a scenario-key prefix (stale-workspace-rescue)', async () => {
    // Regression: the previous `^(\S+)…` sniff regex anchored on the first
    // token, so the two-bare-token shape `<scenario-key> <file> bytes=…`
    // never matched and the scenario came out sniff-blind (latest=null)
    // on a clean pass — the §6 / §9.2 scoring artifact.
    await mkdir(join(tempRoot, 'workspace'), { recursive: true });
    await writeFile(
      join(tempRoot, 'result.json'),
      JSON.stringify({
        trialId: 'rescue-trial',
        scenarioId: 'stale-workspace-rescue',
        modelId: 'claude-sonnet-4.6',
        startedAt: '2026-06-27T00:00:00.000Z',
        finishedAt: '2026-06-27T00:00:20.000Z',
        durationMs: 20_000,
        success: true,
        reason: 'all 6 mission criteria verified',
      }),
    );
    await writeFile(
      join(tempRoot, 'log.txt'),
      [
        '[2026-06-27T00:00:00.000Z] [poll] starting (interval=5000ms maxDuration=1200000ms)',
        '[2026-06-27T00:00:10.000Z] [scenario] stale-workspace-rescue notes.html bytes=6100 score=6/6 signals=title-app-name,textarea-save,localstorage-persistence,search-filter,size-4kb,js-parses',
      ].join('\n'),
    );
    await writeFile(join(tempRoot, 'history.jsonl'), '');

    const facts = score(tempRoot);

    expect(facts.sniff.latest).toEqual({
      filePath: 'notes.html',
      bytes: 6100,
      score: 6,
      scoreMax: 6,
      signals: [
        'title-app-name',
        'textarea-save',
        'localstorage-persistence',
        'search-filter',
        'size-4kb',
        'js-parses',
      ],
      failReason: null,
    });
  });

  it('extracts generic craftbook check scores without named signals', async () => {
    await mkdir(join(tempRoot, 'workspace'), { recursive: true });
    await writeFile(
      join(tempRoot, 'result.json'),
      JSON.stringify({
        trialId: 'craftbook-trial',
        scenarioId: 'craftbook-form-wizard',
        modelId: 'gemma4-e4b-q8',
        startedAt: '2026-06-27T00:00:00.000Z',
        finishedAt: '2026-06-27T00:00:20.000Z',
        durationMs: 20_000,
        success: true,
        reason: 'craftbook-form-wizard passed 8 deterministic craftbook checks',
      }),
    );
    await writeFile(
      join(tempRoot, 'log.txt'),
      [
        '[2026-06-27T00:00:00.000Z] [poll] starting (interval=5000ms maxDuration=1200000ms)',
        '[2026-06-27T00:00:10.000Z] [scenario] craftbook-form-wizard checks=8/8 failures=none',
      ].join('\n'),
    );
    await writeFile(join(tempRoot, 'history.jsonl'), '');

    const facts = score(tempRoot);

    expect(facts.sniff.latest).toEqual({
      filePath: 'craftbook-form-wizard',
      bytes: 0,
      score: 8,
      scoreMax: 8,
      signals: [],
      failReason: null,
    });
  });

  it('uses the first generic craftbook check failure as the fail reason', async () => {
    await mkdir(join(tempRoot, 'workspace'), { recursive: true });
    await writeFile(
      join(tempRoot, 'result.json'),
      JSON.stringify({
        trialId: 'craftbook-trial',
        scenarioId: 'craftbook-form-wizard',
        modelId: 'gemma4-e4b-q8',
        startedAt: '2026-06-27T00:00:00.000Z',
        finishedAt: '2026-06-27T00:00:20.000Z',
        durationMs: 20_000,
        success: false,
        reason: 'timeout',
      }),
    );
    await writeFile(
      join(tempRoot, 'log.txt'),
      [
        '[2026-06-27T00:00:00.000Z] [poll] starting (interval=5000ms maxDuration=1200000ms)',
        '[2026-06-27T00:00:10.000Z] [scenario] craftbook-form-wizard checks=2/8 failures=index.html is 0 bytes, need >= 2600 | CSS is 0 bytes',
      ].join('\n'),
    );
    await writeFile(join(tempRoot, 'history.jsonl'), '');

    const facts = score(tempRoot);

    expect(facts.sniff.latest).toEqual({
      filePath: 'craftbook-form-wizard',
      bytes: 0,
      score: 2,
      scoreMax: 8,
      signals: [],
      failReason: 'index.html is 0 bytes, need >= 2600',
    });
  });
});

describe('score-trial runtime sniff reporting', () => {
  it('prefers terminal result runtime counters over an earlier runtime log snapshot', async () => {
    await writeFile(
      join(tempRoot, 'result.json'),
      JSON.stringify({
        trialId: 'runtime-failure-trial',
        scenarioId: 'petshop',
        modelId: 'gemma4-e4b-q8',
        startedAt: '2026-07-10T00:00:00.000Z',
        finishedAt: '2026-07-10T00:00:20.000Z',
        durationMs: 20_000,
        success: false,
        reason: 'runtime assertion failed',
        finalSniff: {
          key: 'pet-shop/workspace/index.html',
          score: 5,
          bytes: 6_656,
          runtimePassed: 3,
          runtimeFailed: 1,
        },
      }),
    );
    await writeFile(
      join(tempRoot, 'log.txt'),
      [
        '[2026-07-10T00:00:00.000Z] [poll] starting (interval=5000ms maxDuration=120000ms)',
        '[2026-07-10T00:00:10.000Z] [scenario] pet-shop/workspace/index.html bytes=6656 score=5/5 signals=pet-vocab,store-vocab,structured-page,working-image,image-asset',
        '[2026-07-10T00:00:11.000Z] [scenario] pet-shop/workspace/index.html#runtime passed=5 failed=0',
      ].join('\n'),
    );

    const facts = score(tempRoot);

    expect(facts.sniff.latest).toMatchObject({
      filePath: 'pet-shop/workspace/index.html',
      score: 5,
      scoreMax: 5,
      runtimePassed: 3,
      runtimeFailed: 1,
    });
    expect(facts.sniff.progression).toHaveLength(1);
    expect(facts.sniff.progression[0]).not.toHaveProperty('runtimePassed');
    expect(facts.sniff.progression[0]).not.toHaveProperty('runtimeFailed');
  });

  it('uses the latest matching runtime log snapshot for successful and legacy results', async () => {
    await writeFile(
      join(tempRoot, 'result.json'),
      JSON.stringify({
        trialId: 'runtime-success-trial',
        scenarioId: 'tankcombat',
        modelId: 'gemma4-e4b-q8',
        startedAt: '2026-07-10T00:00:00.000Z',
        finishedAt: '2026-07-10T00:00:20.000Z',
        durationMs: 20_000,
        success: true,
        reason: 'static and runtime checks passed',
      }),
    );
    await writeFile(
      join(tempRoot, 'log.txt'),
      [
        '[2026-07-10T00:00:00.000Z] [poll] starting (interval=5000ms maxDuration=120000ms)',
        '[2026-07-10T00:00:10.000Z] [scenario] tank-combat/workspace/index.html bytes=6200 score=9/9 signals=tank-vocab,render-surface',
        '[2026-07-10T00:00:11.000Z] [scenario] tank-combat/workspace/index.html#runtime passed=1 failed=2 failures: input="no state change"',
        '[2026-07-10T00:00:15.000Z] [scenario] tank-combat/workspace/index.html#runtime passed=3 failed=0',
      ].join('\n'),
    );

    const facts = score(tempRoot);

    expect(facts.sniff.latest).toMatchObject({ runtimePassed: 3, runtimeFailed: 0 });
    // Runtime reports are point-in-time snapshots: repeated reports neither
    // become static sniff entries nor get summed (which would yield 4/2).
    expect(facts.sniff.progression).toHaveLength(1);
  });

  it('reports an attempted but unavailable runtime layer as unknown, not zero failures', async () => {
    await writeFile(
      join(tempRoot, 'result.json'),
      JSON.stringify({
        trialId: 'runtime-bootstrap-trial',
        scenarioId: 'petshop',
        modelId: 'gemma4-e4b-q8',
        startedAt: '2026-07-10T00:00:00.000Z',
        finishedAt: '2026-07-10T00:00:20.000Z',
        durationMs: 20_000,
        success: true,
        reason: 'static sniff passed; runtime layer unavailable',
      }),
    );
    await writeFile(
      join(tempRoot, 'log.txt'),
      [
        '[2026-07-10T00:00:00.000Z] [poll] starting (interval=5000ms maxDuration=120000ms)',
        '[2026-07-10T00:00:10.000Z] [scenario] pet-shop/workspace/index.html bytes=6656 score=5/5 signals=pet-vocab,store-vocab,structured-page,working-image,image-asset',
        '[2026-07-10T00:00:11.000Z] [scenario] pet-shop/workspace/index.html#runtime BOOTSTRAP_FAIL "chromium missing"',
      ].join('\n'),
    );

    const facts = score(tempRoot);

    expect(facts.sniff.latest).toMatchObject({ runtimePassed: null, runtimeFailed: null });
  });

  it('keeps runtime fields optional for historical results with no runtime evidence', async () => {
    await writeFile(
      join(tempRoot, 'result.json'),
      JSON.stringify({
        trialId: 'legacy-static-trial',
        scenarioId: 'petshop',
        modelId: 'gemma4-e4b-q8',
        startedAt: '2026-06-01T00:00:00.000Z',
        finishedAt: '2026-06-01T00:00:20.000Z',
        durationMs: 20_000,
        success: false,
        reason: 'timeout',
        finalSniff: {
          key: 'pet-shop/workspace/index.html',
          score: 5,
          bytes: 6_656,
        },
      }),
    );
    await writeFile(
      join(tempRoot, 'log.txt'),
      '[2026-06-01T00:00:10.000Z] [scenario] pet-shop/workspace/index.html bytes=6656 score=5/5 signals=pet-vocab,store-vocab,structured-page,working-image,image-asset',
    );

    const facts = score(tempRoot);

    expect(facts.sniff.latest).not.toHaveProperty('runtimePassed');
    expect(facts.sniff.latest).not.toHaveProperty('runtimeFailed');
  });
});

describe('score-trial image-asset gate', () => {
  it('carries the scenario image-gate verdict onto matching image files', async () => {
    await mkdir(join(tempRoot, 'workspace'), { recursive: true });
    await writeFile(join(tempRoot, 'workspace', 'sunset.png'), Buffer.alloc(447_573, 1));
    await writeFile(
      join(tempRoot, 'result.json'),
      JSON.stringify({
        trialId: 'image-trial',
        scenarioId: 'tool-routing-image',
        modelId: 'claude-sonnet-4.6',
        startedAt: '2026-06-27T00:00:00.000Z',
        finishedAt: '2026-06-27T00:00:10.000Z',
        durationMs: 10_000,
        success: true,
        reason: 'default/workspace/sunset.png (447573 bytes)',
      }),
    );
    await writeFile(
      join(tempRoot, 'log.txt'),
      [
        '[2026-06-27T00:00:00.000Z] [poll] starting (interval=5000ms maxDuration=1200000ms)',
        '[2026-06-27T00:00:05.000Z] [scenario] image default/workspace/sunset.png bytes=447573 (real)',
        '[2026-06-27T00:00:05.000Z] [scenario] generate_image tool.called events: yes',
      ].join('\n'),
    );
    await writeFile(
      join(tempRoot, 'history.jsonl'),
      JSON.stringify({
        kind: 'gezel.created',
        details: { role: 'Image Generator' },
      }),
    );

    const facts = score(tempRoot);

    expect(facts.artifacts.imageFiles).toEqual([
      { path: 'workspace/sunset.png', bytes: 447_573, real: true },
    ]);
    expect(facts.team.missingExpectedRoles).toEqual([]);
    // No HTML sniff for an image gate — but the gate verdict is now on disk.
    expect(facts.sniff.latest).toBeNull();
  });

  it('marks an undersized image as not real and leaves unmatched images unflagged', async () => {
    await mkdir(join(tempRoot, 'workspace'), { recursive: true });
    await writeFile(join(tempRoot, 'workspace', 'tiny.png'), Buffer.alloc(900, 1));
    await writeFile(join(tempRoot, 'workspace', 'incidental.png'), Buffer.alloc(2048, 1));
    await writeFile(
      join(tempRoot, 'result.json'),
      JSON.stringify({
        trialId: 'image-trial',
        scenarioId: 'tool-routing-image',
        modelId: 'qwen3.6-27b-q4',
        startedAt: '2026-06-27T00:00:00.000Z',
        finishedAt: '2026-06-27T00:00:10.000Z',
        durationMs: 10_000,
        success: false,
        reason: 'no real image asset',
      }),
    );
    await writeFile(
      join(tempRoot, 'log.txt'),
      [
        '[2026-06-27T00:00:00.000Z] [poll] starting (interval=5000ms maxDuration=1200000ms)',
        '[2026-06-27T00:00:05.000Z] [scenario] image default/workspace/tiny.png bytes=900 (too small)',
      ].join('\n'),
    );
    await writeFile(join(tempRoot, 'history.jsonl'), '');

    const facts = score(tempRoot);

    const byPath = Object.fromEntries(facts.artifacts.imageFiles.map((f) => [f.path, f]));
    expect(byPath['workspace/tiny.png']).toEqual({
      path: 'workspace/tiny.png',
      bytes: 900,
      real: false,
    });
    // The gate never graded this one — `real` must be absent, not guessed.
    expect(byPath['workspace/incidental.png']).toEqual({
      path: 'workspace/incidental.png',
      bytes: 2048,
    });
    expect(facts.team.missingExpectedRoles).toEqual(['image-generator']);
  });
});

describe('score-trial modelTier passthrough (Theme E / E1-B)', () => {
  it('copies modelTier from result.json into the facts (policy-free, like modelId)', async () => {
    await writeFile(
      join(tempRoot, 'result.json'),
      JSON.stringify({
        trialId: 'tier-trial',
        scenarioId: 'petshop',
        modelId: 'gemma4-e2b-q8',
        modelTier: 'tiny',
        startedAt: '2026-07-08T00:00:00.000Z',
        finishedAt: '2026-07-08T00:00:10.000Z',
        durationMs: 10_000,
        success: false,
        reason: 'no primary deliverable',
        failureMode: 'no-progress',
      }),
    );
    await writeFile(
      join(tempRoot, 'log.txt'),
      '[2026-07-08T00:00:00.000Z] [poll] starting (interval=5000ms maxDuration=100000ms)\n',
    );
    await writeFile(join(tempRoot, 'history.jsonl'), '');

    const facts = score(tempRoot);
    expect(facts.modelTier).toBe('tiny');
    expect(facts.modelId).toBe('gemma4-e2b-q8');
  });

  it('omits modelTier when result.json predates the stamp', async () => {
    await writeFile(
      join(tempRoot, 'result.json'),
      JSON.stringify({
        trialId: 'legacy-trial',
        scenarioId: 'petshop',
        modelId: 'gemma4-e2b-q8',
        startedAt: '2026-06-01T00:00:00.000Z',
        finishedAt: '2026-06-01T00:00:10.000Z',
        durationMs: 10_000,
        success: true,
        reason: 'ok',
      }),
    );
    await writeFile(
      join(tempRoot, 'log.txt'),
      '[2026-06-01T00:00:00.000Z] [poll] starting (interval=5000ms maxDuration=100000ms)\n',
    );
    await writeFile(join(tempRoot, 'history.jsonl'), '');

    const facts = score(tempRoot);
    expect(facts.modelTier).toBeUndefined();
  });
});

describe('score-trial failReason with embedded quotes', () => {
  it('keeps the whole reason when the scenario quotes a value inside it', async () => {
    // Scenario writers interpolate the reason raw, so a reason that quotes a
    // section name used to terminate the match at the inner quote — the eval
    // said "out-of-order at " and dropped the one fact that made it actionable.
    await writeFile(
      join(tempRoot, 'result.json'),
      JSON.stringify({
        trialId: 'quote-trial',
        scenarioId: 'incident-postmortem',
        modelId: 'qwen3.6-27b-q8',
        startedAt: '2026-08-01T00:00:00.000Z',
        finishedAt: '2026-08-01T00:00:10.000Z',
        durationMs: 10_000,
        success: false,
        reason: 'stalled',
        failureMode: 'model-stuck',
      }),
    );
    await writeFile(
      join(tempRoot, 'log.txt'),
      [
        '[2026-08-01T00:00:00.000Z] [poll] starting (interval=5000ms maxDuration=720000ms)',
        '[2026-08-01T00:00:10.000Z] [scenario] postmortem.md bytes=8951 score=8/9 signals=file-present failReason="all-sections: missing or out-of-order at "Timeline""',
      ].join('\n'),
    );
    await writeFile(join(tempRoot, 'history.jsonl'), '');

    const facts = score(tempRoot);

    expect(facts.sniff.latest?.failReason).toBe(
      'all-sections: missing or out-of-order at "Timeline"',
    );
  });

  it('still handles a properly escaped reason', async () => {
    await writeFile(
      join(tempRoot, 'result.json'),
      JSON.stringify({
        trialId: 'escaped-trial',
        scenarioId: 'incident-postmortem',
        modelId: 'gemma4-e4b-q8',
        startedAt: '2026-08-01T00:00:00.000Z',
        finishedAt: '2026-08-01T00:00:10.000Z',
        durationMs: 10_000,
        success: false,
        reason: 'stalled',
        failureMode: 'model-stuck',
      }),
    );
    await writeFile(
      join(tempRoot, 'log.txt'),
      [
        '[2026-08-01T00:00:00.000Z] [poll] starting (interval=5000ms maxDuration=720000ms)',
        '[2026-08-01T00:00:10.000Z] [scenario] postmortem.md bytes=100 score=1/9 signals=none failReason="missing \\"Timeline\\" header"',
      ].join('\n'),
    );
    await writeFile(join(tempRoot, 'history.jsonl'), '');

    expect(score(tempRoot).sniff.latest?.failReason).toBe('missing "Timeline" header');
  });
});
