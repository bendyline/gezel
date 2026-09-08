import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  THINKING_PROBES,
  buildBudgetPlan,
  checkBudgetDiagnostics,
  checkProbe,
  classifyProbeError,
  experimentProvenance,
  inspectThinkingOutput,
  isCompletedProbeResult,
  parseBudgetDiagnostics,
  resetProbeArtifacts,
  resetProbeWorkspace,
  resolveProbeError,
  thinkingDaemonArtifact,
} from './ab-thinking-budget.ts';

const testRoots: string[] = [];
afterEach(async () => {
  await Promise.all(testRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('thinking probe workspace reset', () => {
  it('removes stale extras and fixture files while preserving the watched directory and siblings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gezel-budget-reset-'));
    testRoots.push(root);
    const workspace = join(root, 'workspaces', 'probe');
    const sibling = join(root, 'workspaces', 'sibling');
    await mkdir(join(workspace, 'unexpected'), { recursive: true });
    await mkdir(sibling);
    await writeFile(join(workspace, 'report.md'), 'stale report');
    await writeFile(join(workspace, 'sums.js'), 'old fixture');
    await writeFile(join(workspace, 'unexpected', 'nested.txt'), 'stale nested output');
    await writeFile(join(sibling, 'keep.txt'), 'keep');
    const before = await stat(workspace);
    await resetProbeWorkspace(root, workspace);
    expect(await readdir(workspace)).toEqual([]);
    expect((await stat(workspace)).ino).toBe(before.ino);
    expect(await readFile(join(sibling, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('refuses paths outside the owned workspaces without removing their contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gezel-budget-reset-'));
    testRoots.push(root);
    const outside = join(root, 'elsewhere');
    await mkdir(outside);
    await writeFile(join(outside, 'keep.txt'), 'keep');
    await expect(resetProbeWorkspace(root, outside)).rejects.toThrow('outside');
    await expect(resetProbeWorkspace(root, join(root, 'workspaces'))).rejects.toThrow('outside');
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('refuses a redirected workspace even when its lexical path is owned', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gezel-budget-reset-'));
    testRoots.push(root);
    const outside = join(root, 'elsewhere');
    const workspace = join(root, 'workspaces', 'probe');
    await mkdir(outside);
    await mkdir(join(root, 'workspaces'));
    await writeFile(join(outside, 'keep.txt'), 'keep');
    await symlink(outside, workspace, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(resetProbeWorkspace(root, workspace)).rejects.toThrow('redirected');
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('removes a stale directory link without following it outside the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gezel-budget-reset-'));
    testRoots.push(root);
    const workspace = join(root, 'workspaces', 'probe');
    const outside = join(root, 'elsewhere');
    await mkdir(workspace, { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, 'keep.txt'), 'keep');
    await symlink(
      outside,
      join(workspace, 'stale-link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await resetProbeWorkspace(root, workspace);
    expect(await readdir(workspace)).toEqual([]);
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
  });
});

describe('thinking probe artifact reset', () => {
  it('clears prior-arm artifacts while retaining the project, artifact directory and siblings', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gezel-budget-artifacts-'));
    testRoots.push(home);
    const projectRoot = join(home, 'projects', 'probe');
    const artifacts = join(projectRoot, 'artifacts');
    const sibling = join(home, 'projects', 'sibling', 'artifacts');
    await mkdir(join(artifacts, 'nested'), { recursive: true });
    await mkdir(sibling, { recursive: true });
    await writeFile(join(projectRoot, 'project.json'), '{"name":"Chat"}');
    await writeFile(join(artifacts, 'report.md'), 'first-arm report');
    await writeFile(join(artifacts, 'nested', 'extra.txt'), 'first-arm extra');
    await writeFile(join(sibling, 'keep.txt'), 'keep');
    const before = await stat(artifacts);

    await resetProbeArtifacts(home, 'probe');

    expect(await readdir(artifacts)).toEqual([]);
    expect((await stat(artifacts)).ino).toBe(before.ino);
    expect(await readFile(join(projectRoot, 'project.json'), 'utf8')).toBe('{"name":"Chat"}');
    expect(await readFile(join(sibling, 'keep.txt'), 'utf8')).toBe('keep');
    await writeFile(join(artifacts, 'report.md'), 'second-arm report');
    await resetProbeArtifacts(home, 'probe');
    expect(await readdir(artifacts)).toEqual([]);
  });

  it.each(['../outside', 'probe/../../outside', '..\\outside'])(
    'refuses a traversing project id %s before touching disk',
    async (projectId) => {
      const home = await mkdtemp(join(tmpdir(), 'gezel-budget-artifacts-'));
      testRoots.push(home);
      const outside = join(home, 'outside', 'artifacts');
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, 'keep.txt'), 'keep');
      await expect(resetProbeArtifacts(home, projectId)).rejects.toThrow('single-segment');
      expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
    },
  );

  it.each(['project', 'artifacts'])(
    'refuses a redirected %s directory even inside the isolated home',
    async (redirect) => {
      const home = await mkdtemp(join(tmpdir(), 'gezel-budget-artifacts-'));
      testRoots.push(home);
      const projectRoot = join(home, 'projects', 'probe');
      const sibling = join(home, 'projects', 'sibling');
      await mkdir(join(sibling, 'artifacts'), { recursive: true });
      await writeFile(join(sibling, 'artifacts', 'keep.txt'), 'keep');
      if (redirect === 'artifacts') await mkdir(projectRoot);
      await symlink(
        redirect === 'project' ? sibling : join(sibling, 'artifacts'),
        redirect === 'project' ? projectRoot : join(projectRoot, 'artifacts'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      await expect(resetProbeArtifacts(home, 'probe')).rejects.toThrow('redirected');
      expect(await readFile(join(sibling, 'artifacts', 'keep.txt'), 'utf8')).toBe('keep');
    },
  );
});

describe('thinking budget experiment controls', () => {
  it('records the resolved default runtime and detects a rebuild before resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gezel-budget-runtime-'));
    testRoots.push(root);
    const entry = join(root, 'gezeld.js');
    await writeFile(entry, '// first compiled runtime');
    const initial = thinkingDaemonArtifact(undefined, () => entry);
    expect(initial.daemonEntry).toBe(entry);
    expect(initial.size).toBeGreaterThan(0);
    await writeFile(entry, '// rebuilt compiled runtime with different bytes');
    expect(thinkingDaemonArtifact(undefined, () => entry)).not.toEqual(initial);
    expect(
      thinkingDaemonArtifact(entry, () => {
        throw new Error('must use explicit entry');
      }),
    ).toEqual(thinkingDaemonArtifact(undefined, () => entry));
  });

  it('pins harness bytes, required project authority and scoped capacity environment for resume', () => {
    const original = experimentProvenance('harness v1', {
      GEZEL_NATIVE_CAPACITY_AUTHORITY: 'local',
    });
    expect(original.harnessSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(original.projectWritePolicy).toBe('allow');
    expect(original.environment.GEZEL_NATIVE_CAPACITY_AUTHORITY).toBe('local');
    expect(
      experimentProvenance('harness v1', { GEZEL_NATIVE_CAPACITY_AUTHORITY: 'local' }),
    ).toEqual(original);
    expect(
      experimentProvenance('harness v2', { GEZEL_NATIVE_CAPACITY_AUTHORITY: 'local' }),
    ).not.toEqual(original);
    expect(experimentProvenance('harness v1', {})).not.toEqual(original);
  });

  it('records the same scoped speculation override applied to the trial config', () => {
    const original = experimentProvenance('harness v1', {});
    const noSpec = experimentProvenance('harness v1', { GEZEL_EVAL_LLAMA_SPEC_TYPE: 'none' });
    expect(original.engineOverrides).toEqual({});
    expect(noSpec.engineOverrides).toEqual({ llamaCppSpecType: 'none' });
    expect(noSpec).not.toEqual(original);
  });

  it('reports structured service errors before missing request diagnostics', () => {
    const message =
      'The installed machine engine needs an update before isolated local engines can share memory safely.';
    expect(
      resolveProbeError(
        { lastTurnError: message, lastTurnErrorDetail: { code: 'capacity-denied' } },
        false,
      ),
    ).toBe(`capacity-denied: ${message}`);
    expect(
      resolveProbeError({ lastTurnErrorDetail: { code: 'native-engine-crash' } }, true),
    ).toContain('native-engine-crash');
  });

  it('keeps genuine answer checks eligible and reports execution or diagnostic failures separately', () => {
    expect(resolveProbeError({}, true)).toBeUndefined();
    expect(resolveProbeError({}, true, 'operator interrupted')).toBe('operator interrupted');
    expect(resolveProbeError({}, false)).toContain('excluded from model comparison');
  });

  it.each([
    ['turn-aborted', "The model couldn't apply its file edit after 5 tries.", 'model'],
    [undefined, '[llama-cpp] too many tool-call loops (>30); aborting to prevent runaway', 'model'],
    [
      undefined,
      '[llama-cpp] post-reasoning runaway — the model kept emitting private reasoning',
      'model',
    ],
    [
      undefined,
      '[llama-cpp] aborting — the gezel emitted 9000 characters of prose this turn without calling any action tool.',
      'model',
    ],
    [
      'turn-aborted',
      'Gezel lost its internal tool connection, so the turn was stopped after 5 failed calls.',
      'infra',
    ],
    ['capacity-denied', 'The installed machine engine needs an update.', 'infra'],
    ['native-engine-crash', 'The engine stopped.', 'infra'],
    [undefined, 'Error: fetch failed', 'infra'],
    [undefined, 'probe exceeded timeout; excluded from capability interpretation', 'incomplete'],
    [undefined, 'unrecognized provider exception', 'incomplete'],
    [undefined, 'operator interrupted', 'operator'],
  ])('classifies %s / %s as %s', (code, error, expected) => {
    expect(classifyProbeError(code ? { lastTurnErrorDetail: { code } } : {}, true, error)).toBe(
      expected,
    );
  });

  it('keeps both execution and service evidence and does not score an unverified arm', () => {
    expect(resolveProbeError({ lastTurnError: 'provider stopped' }, true, 'capture failed')).toBe(
      'provider stopped\ncapture failed',
    );
    expect(
      classifyProbeError({ lastTurnErrorDetail: { code: 'turn-aborted' } }, false, 'model aborted'),
    ).toBe('infra');
    expect(classifyProbeError({}, true, 'model aborted', true)).toBe('operator');
    expect(classifyProbeError({}, false, 'probe exceeded timeout')).toBe('incomplete');
  });

  it('resumes past completed model failures while retrying incomplete or invalid measurements', () => {
    const completed = {
      configValid: true,
      includedInModelAggregate: true,
      passed: false,
      failureClass: 'model',
      error: 'too many tool-call loops',
    };
    expect(isCompletedProbeResult(completed)).toBe(true);
    expect(isCompletedProbeResult({ ...completed, error: undefined })).toBe(true);
    expect(
      isCompletedProbeResult({
        ...completed,
        passed: true,
        failureClass: 'pass',
        error: undefined,
      }),
    ).toBe(true);
    expect(isCompletedProbeResult({ ...completed, configValid: false })).toBe(false);
    expect(
      isCompletedProbeResult({
        ...completed,
        passed: null,
        failureClass: 'incomplete',
        includedInModelAggregate: false,
      }),
    ).toBe(false);
    expect(isCompletedProbeResult({ configValid: true, error: undefined })).toBe(false);
  });
  it('pairs every seed/probe across all budgets and rotates the first arm', () => {
    const probes = THINKING_PROBES.slice(0, 2);
    const plan = buildBudgetPlan(probes, [96, 512, 2048, 4096], 3);
    expect(plan).toHaveLength(24);
    expect(new Set(plan.map((c) => c.id)).size).toBe(24);
    for (const seed of [0, 1, 2])
      for (const probe of probes) {
        expect(
          plan
            .filter((c) => c.seed === seed && c.probeId === probe.id)
            .map((c) => c.budget)
            .sort((a, b) => a - b),
        ).toEqual([96, 512, 2048, 4096]);
      }
    expect(plan[0]?.budget).toBe(96);
    expect(plan[4]?.budget).toBe(512);
    expect(plan[8]?.budget).toBe(512);
  });

  it('rejects collapsed cell identities and invalid seeds or budgets', () => {
    expect(() => buildBudgetPlan(THINKING_PROBES, [96, 96], 1)).toThrow();
    expect(() => buildBudgetPlan(THINKING_PROBES, [0], 1)).toThrow();
    expect(() => buildBudgetPlan(THINKING_PROBES, [96], 1, -1)).toThrow();
  });

  it('extracts request truth and counts an exhausted reasoning cap once', () => {
    const result = parseBudgetDiagnostics(
      [
        '[llama-cpp] request-reasoning {"enableThinking":true,"reasoningBudgetTokens":2048}',
        'reasoning-budget: budget exhausted, forcing end sequence',
        '[llama-cpp] request-reasoning {truncated',
        '[chat] nudge budget exhausted (2/2)',
      ].join('\n'),
    );
    expect(result.requests).toEqual([{ enableThinking: true, reasoningBudgetTokens: 2048 }]);
    expect(result.forcedEndCount).toBe(1);
  });

  it('distinguishes the native natural end from UTF-8 deferred forced closure', () => {
    const result = parseBudgetDiagnostics(
      [
        'cmn common_reaso: deactivated (natural end)',
        'cmn common_reaso: budget exhausted, waiting for UTF-8 completion',
        'cmn common_reaso: UTF-8 complete, now forcing end sequence',
        'cmn common_reaso: forced sequence complete, done',
      ].join('\n'),
    );
    expect(result.naturalEndCount).toBe(1);
    expect(result.forcedEndCount).toBe(1);
  });

  it('counts actual recovery sends once across detector and continuation log lines', () => {
    const log = [
      'WARN [chat] runSend#fe78c6f3 prose-deliverable: model wrote a structured report in chat but never called a write tool (inferred report.md)',
      'INFO [chat] continuing stalled session fe78c6f3-b2b0-41ea-b85c-511d4a941556 (nudge 1/2, tier=small)',
      '[llama-cpp] request-reasoning {"iteration":0,"reasoningBudgetTokens":96,"enableThinking":true}',
      '[llama-cpp] request-reasoning {"iteration":1,"reasoningBudgetTokens":96,"enableThinking":true}',
      'INFO [chat] session fe78c6f3: response looks stalled (tool-only) — requesting one recovery pass',
      'INFO [chat] continuing stalled session fe78c6f3-b2b0-41ea-b85c-511d4a941556 (nudge 2/2, tier=small)',
    ];
    expect(parseBudgetDiagnostics(log.slice(0, 4).join('\n')).recoveryCount).toBe(1);
    expect(parseBudgetDiagnostics(log.join('\n')).recoveryCount).toBe(2);
    expect(parseBudgetDiagnostics(log[0]!).recoveryCount).toBe(0);
  });

  it('admits product turns that disable thinking as non-informative regression controls', () => {
    const diagnostics = parseBudgetDiagnostics(
      '[llama-cpp] request-reasoning {"enableThinking":false,"reasoningBudgetTokens":96}',
    );
    expect(checkBudgetDiagnostics(diagnostics, 96)).toEqual({
      configValid: true,
      thinkingEnabledRequestCount: 0,
      thinkingDisabledRequestCount: 1,
      informativeForThinkingBudget: false,
    });
    expect(checkBudgetDiagnostics(diagnostics, 2048).configValid).toBe(false);
    expect(checkBudgetDiagnostics(parseBudgetDiagnostics(''), 96).configValid).toBe(false);
  });

  it('flags the original mid-sentence channel boundary without exposing reasoning as content', () => {
    const result = inspectThinkingOutput([
      {
        role: 'assistant',
        reasoning: 'without using tools (',
        content: 'as requested). I need to answer the user.',
      },
    ]);
    expect(result.flags).toContain('possible-mid-sentence-channel-boundary');
    expect(result.flags).toContain('possible-planning-in-content');
    expect(result.content).not.toContain('without using tools');
  });

  it('does not call a normal first-person answer reasoning leakage', () => {
    expect(
      inspectThinkingOutput([
        { role: 'assistant', content: 'I recommend asking your neighbor politely.' },
      ]).flags,
    ).toEqual([]);
  });

  it('checks the ordered solution rather than four letters appearing anywhere', async () => {
    const probe = THINKING_PROBES.find((p) => p.id === 'logic-order')!;
    const good = inspectThinkingOutput([
      { role: 'assistant', content: 'The order is D → A → C → B.' },
    ]);
    const bad = inspectThinkingOutput([{ role: 'assistant', content: 'The order is D, A, B, C.' }]);
    expect((await checkProbe(probe, '', good)).passed).toBe(true);
    expect((await checkProbe(probe, '', bad)).passed).toBe(false);
  });

  it.each([
    ['55 bolts remain.', true],
    ['47 + 3 × 28 − 4 × 19 = 55.', true],
    ['155 bolts remain.', false],
    ['55.5 bolts remain.', false],
    ['-55 bolts remain.', false],
    ['0.55 bolts remain.', false],
  ])('checks complete arithmetic numbers in %s', async (content, passed) => {
    const probe = THINKING_PROBES.find((p) => p.id === 'arithmetic')!;
    const output = inspectThinkingOutput([{ role: 'assistant', content }]);
    expect((await checkProbe(probe, '', output)).passed).toBe(passed);
  });

  it.each([
    ['The probability is 3/5.', true],
    ['The probability is 6 / 10.', true],
    ['The probability is \\(\\frac{3}{5}\\).', true],
    ['The probability is $$\\dfrac{12}{20}$$.', true],
    ['The probability is 13/5.', false],
    ['The probability is 3/50.', false],
    ['The probability is \\(\\frac{3}{7}\\).', false],
    ['The probability is 6/0.', false],
    ['The probability is -3/5.', false],
  ])('checks equivalent exact fractions in %s', async (content, passed) => {
    const probe = THINKING_PROBES.find((p) => p.id === 'probability')!;
    const output = inspectThinkingOutput([{ role: 'assistant', content }]);
    expect((await checkProbe(probe, '', output)).passed).toBe(passed);
  });

  it.each(['unconfirmed', 'uncertain', 'not confirmed', 'not established', 'unknown'])(
    'accepts a grounded summary retaining cause uncertainty as %s',
    async (uncertainty) => {
      const probe = THINKING_PROBES.find((p) => p.id === 'grounded-summary')!;
      const output = inspectThinkingOutput([
        {
          role: 'assistant',
          content: `Pressure fell after filter replacement and returned to normal after tightening a fitting. The cause remains ${uncertainty}.`,
        },
      ]);
      expect((await checkProbe(probe, '', output)).passed).toBe(true);
    },
  );

  it('rejects a summary that asserts a confirmed cause despite matching its topic keywords', async () => {
    const probe = THINKING_PROBES.find((p) => p.id === 'grounded-summary')!;
    const output = inspectThinkingOutput([
      {
        role: 'assistant',
        content:
          'The filter replacement caused the pressure loss. Tightening the fitting fixed it.',
      },
    ]);
    expect((await checkProbe(probe, '', output)).failures).toContain(
      'summary omits uncertainty about the cause',
    );
  });

  it('enforces the writing constraint and honors an explicitly tool-permitting fixture', async () => {
    const probe = THINKING_PROBES.find((p) => p.id === 'constraint-writing')!;
    const long = inspectThinkingOutput([
      { role: 'assistant', content: `headphones ${'word '.repeat(71)}` },
    ]);
    expect((await checkProbe(probe, '', long)).failures).toContain('email exceeds 70-word limit');
    const toolAnswer = inspectThinkingOutput([
      {
        role: 'assistant',
        content: 'The file is ready.',
        toolCalls: [{ name: 'writeFile', durationMs: 1, success: true }],
      },
    ]);
    expect(
      (
        await checkProbe(
          { id: 'fixture', prompt: 'Write a note.', allowTools: true },
          '',
          toolAnswer,
        )
      ).passed,
    ).toBe(true);
  });
});
