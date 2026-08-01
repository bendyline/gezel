import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GezelClient } from '@bendyline/gezel-client/node';
import { describe, expect, it, vi } from 'vitest';
import {
  PoisonedSessionRecoveryTracker,
  behaviorEnvForTrial,
  buildPoisonedSessionRecoveryMessage,
  buildReEngageNudge,
  canDispatchPoisonedSessionRecovery,
  completedRepairActionSnapshot,
  defaultSoftProgressTimeoutMsForModel,
  ds4EvalLaunchOverridesForModel,
  ds4EvalShouldUseSsdStreaming,
  evalDaemonEnvForTrial,
  inflightDeferMsForEngine,
  llamaCppEvalLaunchOverridesForModel,
  localEvalDeviceSafetyConfig,
  makeTrialId,
  pickPoisonedSessionsForRecovery,
  poisonedRecoveryFailureFingerprint,
  pollUntilDone,
  readCapacityDenialFromLog,
  readContextOverflowFromLog,
  recoveryFilePathForSniff,
  repeatedPoisonedSessionFailure,
  retryLoopSniffKey,
  shouldDeferRetryLoopForInflight,
  shouldDeferSoftWatchdog,
  slugifyForDirName,
  sniffArtifactHasScored,
  sniffKeyToWorkspaceFilePath,
  summarizeInflightTurnsForLog,
  taskGraphPoisonedSessionRecoveryLine,
} from './runner.ts';
import type { EvalScenario } from './types.ts';

function terminalHandoffTestClient(): GezelClient {
  return {
    listProjects: vi.fn().mockResolvedValue({ projects: [] }),
    listChatSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    listSessionTelemetry: vi.fn().mockResolvedValue({ sessions: [] }),
  } as unknown as GezelClient;
}

describe('completed repair-action snapshots', () => {
  it('counts committed successful file-mutation turns, not calls, failures, or reads', () => {
    const snapshot = completedRepairActionSnapshot(
      {
        messages: [
          { role: 'user', toolCalls: [{ name: 'write_file', success: true }] },
          { role: 'assistant', toolCalls: [{ name: 'read_file', success: true }] },
          { role: 'assistant', toolCalls: [{ name: 'replace_in_file', success: false }] },
          {
            role: 'assistant',
            toolCalls: [
              { name: 'replace_lines', success: false },
              { name: 'write_file', success: true },
            ],
          },
          { role: 'assistant', toolCalls: [{ name: 'apply_patch', success: true }] },
        ],
      },
      false,
    );

    expect(snapshot).toEqual({ completedMutationTurns: 2, inflight: false });
  });

  it('carries the live in-flight bit separately from committed action count', () => {
    expect(
      completedRepairActionSnapshot(
        {
          messages: [{ role: 'assistant', toolCalls: [{ name: 'append_to_file', success: true }] }],
        },
        true,
      ),
    ).toEqual({ completedMutationTurns: 1, inflight: true });
  });
});

describe('scenario terminal failure handoff', () => {
  it('ends immediately with the latest sniff when a bounded helper exhausts', async () => {
    const logs: string[] = [];
    let checks = 0;
    const scenario: EvalScenario = {
      id: 'terminal-handoff-test',
      description: 'test',
      prompt: 'test',
      successCheck: async (ctx) => {
        checks += 1;
        ctx.recordSniff?.({
          key: 'source-check',
          score: 2,
          bytes: 3023,
          failReason: 'same assertion failure',
          repairFilePath: 'src/machine.ts',
        });
        ctx.requestTerminalFailure?.({
          reason: 'repair-exhausted: four checked revisions missed the same assertion',
          failureMode: 'model-stuck',
        });
        return { done: false };
      },
    };

    const verdict = await pollUntilDone(scenario, {
      client: terminalHandoffTestClient(),
      meesterId: 'meester',
      log: (line) => logs.push(line),
      pollIntervalMs: 5_000,
      maxDurationMs: 60_000,
      hardProgressTimeoutMs: 60_000,
      softProgressTimeoutMs: 60_000,
    });

    expect(checks).toBe(1);
    expect(verdict).toEqual({
      success: false,
      reason: 'repair-exhausted: four checked revisions missed the same assertion',
      failureMode: 'model-stuck',
      finalSniff: {
        key: 'source-check',
        score: 2,
        bytes: 3023,
        failReason: 'same assertion failure',
        repairFilePath: 'src/machine.ts',
      },
    });
    expect(logs.join('\n')).toContain('terminal (scenario handoff)');
  });

  it('lets a same-poll scenario success win over an earlier helper request', async () => {
    const scenario: EvalScenario = {
      id: 'terminal-handoff-success-test',
      description: 'test',
      prompt: 'test',
      successCheck: async (ctx) => {
        ctx.requestTerminalFailure?.({
          reason: 'stale repair exhaustion',
          failureMode: 'model-stuck',
        });
        return { done: true, success: true, reason: 'gate closed on final check' };
      },
    };

    await expect(
      pollUntilDone(scenario, {
        client: terminalHandoffTestClient(),
        meesterId: 'meester',
        log: vi.fn(),
        pollIntervalMs: 5_000,
        maxDurationMs: 60_000,
        hardProgressTimeoutMs: 60_000,
        softProgressTimeoutMs: 60_000,
      }),
    ).resolves.toEqual({
      success: true,
      reason: 'gate closed on final check',
      failureMode: undefined,
    });
  });

  it('gives a same-poll context overflow precedence over model exhaustion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gezel-terminal-handoff-'));
    const daemonLogPath = join(dir, 'daemon.log');
    await writeFile(
      daemonLogPath,
      'request (9,999 tokens) exceeds the available context size (8,192 tokens)\n',
    );
    const scenario: EvalScenario = {
      id: 'terminal-handoff-infra-test',
      description: 'test',
      prompt: 'test',
      successCheck: async (ctx) => {
        ctx.requestTerminalFailure?.({
          reason: 'repair exhausted',
          failureMode: 'model-stuck',
        });
        return { done: false };
      },
    };

    try {
      const verdict = await pollUntilDone(scenario, {
        client: terminalHandoffTestClient(),
        meesterId: 'meester',
        log: vi.fn(),
        pollIntervalMs: 5_000,
        maxDurationMs: 60_000,
        hardProgressTimeoutMs: 60_000,
        softProgressTimeoutMs: 60_000,
        daemonLogPath,
      });
      expect(verdict).toMatchObject({
        success: false,
        failureMode: 'spawn-error',
        reason: 'context overflow: 9,999 tokens needed but only 8,192 available',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('behaviorEnvForTrial', () => {
  it('is empty when no overrides are set', () => {
    expect(behaviorEnvForTrial({})).toEqual({});
  });

  it('maps forceBehaviors to GEZEL_FORCE_BEHAVIORS (comma-joined)', () => {
    expect(behaviorEnvForTrial({ forceBehaviors: ['tools.gezels-as-roles'] })).toEqual({
      GEZEL_FORCE_BEHAVIORS: 'tools.gezels-as-roles',
    });
    expect(behaviorEnvForTrial({ forceBehaviors: ['a', 'b'] }).GEZEL_FORCE_BEHAVIORS).toBe('a,b');
  });

  it('maps removeBehaviors to GEZEL_REMOVE_BEHAVIORS', () => {
    expect(behaviorEnvForTrial({ removeBehaviors: ['x'] })).toEqual({
      GEZEL_REMOVE_BEHAVIORS: 'x',
    });
  });
});

describe('evalDaemonEnvForTrial', () => {
  it('disables post-turn memory extraction AND capability-floor routing for eval daemons', () => {
    // Routing is force-OFF: a trial home links several models (chat + image +
    // enrich), so default-on routing would swap craftbook worker steps off the
    // model under evaluation and corrupt the result.
    expect(evalDaemonEnvForTrial({})).toEqual({
      GEZEL_DISABLE_MEMORY_EXTRACTION: '1',
      GEZEL_DISABLE_MODEL_ROUTING: '1',
    });
  });

  it('enableModelRouting opts back in (a dedicated routing eval)', () => {
    expect(evalDaemonEnvForTrial({ enableModelRouting: true })).not.toHaveProperty(
      'GEZEL_DISABLE_MODEL_ROUTING',
    );
  });

  it('locks only local-engine trials to the provider under test', () => {
    expect(evalDaemonEnvForTrial({ providerLock: 'ds4' })).toHaveProperty(
      'GEZEL_EVAL_PROVIDER_LOCK',
      'ds4',
    );
    expect(evalDaemonEnvForTrial({ providerLock: 'llama-cpp' })).toHaveProperty(
      'GEZEL_EVAL_PROVIDER_LOCK',
      'llama-cpp',
    );
    expect(evalDaemonEnvForTrial({ providerLock: 'copilot' })).not.toHaveProperty(
      'GEZEL_EVAL_PROVIDER_LOCK',
    );
  });

  it('merges launch and behavior overrides', () => {
    expect(
      evalDaemonEnvForTrial({
        launch: { extraEnv: { GEZEL_LLAMA_NUM_CTX: '24576' } },
        forceBehaviors: ['a'],
        removeBehaviors: ['b'],
      }),
    ).toMatchObject({
      GEZEL_DISABLE_MEMORY_EXTRACTION: '1',
      GEZEL_LLAMA_NUM_CTX: '24576',
      GEZEL_FORCE_BEHAVIORS: 'a',
      GEZEL_REMOVE_BEHAVIORS: 'b',
    });
  });

  it('maps craftbookDocFormat to GEZEL_CRAFTBOOK_DOC_FORMAT (the format A/B lever)', () => {
    expect(evalDaemonEnvForTrial({ craftbookDocFormat: 'json' })).toEqual({
      GEZEL_DISABLE_MEMORY_EXTRACTION: '1',
      GEZEL_DISABLE_MODEL_ROUTING: '1',
      GEZEL_CRAFTBOOK_DOC_FORMAT: 'json',
    });
    expect(evalDaemonEnvForTrial({ craftbookDocFormat: 'md' }).GEZEL_CRAFTBOOK_DOC_FORMAT).toBe(
      'md',
    );
    // Unset ⇒ absent, so the daemon falls back to its own default codec.
    expect(evalDaemonEnvForTrial({})).not.toHaveProperty('GEZEL_CRAFTBOOK_DOC_FORMAT');
  });
});

describe('slugifyForDirName', () => {
  it('passes through already-clean ids', () => {
    expect(slugifyForDirName('gemma4-e4b-q8')).toBe('gemma4-e4b-q8');
    expect(slugifyForDirName('gpt-5')).toBe('gpt-5');
  });

  it('collapses dots in version tags', () => {
    // `gpt-5.5` would land as a literal `.` in the path which is
    // legal on every platform but confuses any tooling that splits
    // on `.` to find the trial dir's file extension.
    expect(slugifyForDirName('gpt-5.5')).toBe('gpt-5-5');
    expect(slugifyForDirName('claude-sonnet-4.6')).toBe('claude-sonnet-4-6');
  });

  it('replaces slashes in HF-style ids (org/repo)', () => {
    // Path-safety: `/` would split the trial id into two directory
    // segments — we want a flat dir name.
    expect(slugifyForDirName('meta-llama/Llama-3.1-8B-Instruct')).toBe(
      'meta-llama-llama-3-1-8b-instruct',
    );
  });

  it('lowercases for case-insensitive filesystem stability', () => {
    // Windows is case-insensitive; mixing cases would cause `LS`
    // patterns to merge runs that meant to stay distinct.
    expect(slugifyForDirName('Claude-Opus-4-7')).toBe('claude-opus-4-7');
  });

  it('truncates long ids at 40 chars to stay clear of Windows MAX_PATH', () => {
    const long = 'a-very-long-vendor-prefix-meta-llama-3-1-405b-instruct-fp16';
    const slug = slugifyForDirName(long);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.startsWith('a-very-long-vendor-prefix')).toBe(true);
  });

  it('replaces internal whitespace and punctuation with single dashes', () => {
    expect(slugifyForDirName('gpt 5.5 turbo')).toBe('gpt-5-5-turbo');
    expect(slugifyForDirName('model@v1:experimental')).toBe('model-v1-experimental');
  });

  it('returns "unknown" rather than an empty slug', () => {
    // Otherwise the trial dir would end up as
    // `tictactoe-openai--2026-...` (double dash, ambiguous to parse).
    expect(slugifyForDirName('')).toBe('unknown');
    expect(slugifyForDirName('/// ')).toBe('unknown');
  });
});

describe('makeTrialId', () => {
  it('omits the provider segment for llama-cpp (back-compat with existing scripts)', () => {
    // The historical run-dir shape was `<scenario>-<ts>-<rand>`. The
    // new format extends that with `-<provider>-<modelSlug>` BUT
    // keeps the old shape for `llama-cpp` so ad-hoc shell scripts
    // grepping `tictactoe-2026-...` keep matching when nothing
    // changed about how they're running trials.
    const id = makeTrialId('tictactoe', 'llama-cpp', 'gemma4-e4b-q8');
    expect(id.startsWith('tictactoe-gemma4-e4b-')).toBe(true);
    expect(id).not.toContain('-llama-cpp-');
  });

  it('encodes the provider for non-default providers', () => {
    const id = makeTrialId('tictactoe', 'openai', 'gpt-5.5');
    expect(id.startsWith('tictactoe-openai-gpt-5-5-')).toBe(true);
  });

  it('encodes provider + model for codex-cli (the canonical new-provider case)', () => {
    const id = makeTrialId('petshop', 'codex-cli', 'gpt-5.5');
    expect(id.startsWith('petshop-codex-cli-gpt-5-5-')).toBe(true);
  });

  it('ends with the ISO timestamp + random suffix so consecutive trials never collide', () => {
    const id = makeTrialId('tictactoe', 'openai', 'gpt-5');
    // Anything after `<scenario>-<provider>-<modelSlug>-` should be
    // the timestamp (digits + dashes) followed by a 4-char random.
    expect(id).toMatch(/-\d{4}-\d{2}-\d{2}t\d{2}-\d{2}-\d{2}-\d+z-[a-z0-9]{4}$/i);
  });

  it('produces distinct ids for back-to-back same-(scenario,provider,model) calls', () => {
    const a = makeTrialId('tictactoe', 'openai', 'gpt-5');
    const b = makeTrialId('tictactoe', 'openai', 'gpt-5');
    // The random suffix guarantees uniqueness even when wall clock
    // resolution loses (rare in Node but possible in tight loops).
    expect(a).not.toBe(b);
  });
});

describe('soft watchdog inflight handling', () => {
  it('does not defer when no turns are inflight', () => {
    expect(shouldDeferSoftWatchdog([])).toBe(false);
    expect(summarizeInflightTurnsForLog([])).toBe('no turns');
  });

  it('defers while any turn is inflight and summarizes the oldest visible turn', () => {
    const inflight = [
      { sessionId: 'bbbbbbbb-2222', gezelId: 'builder', projectId: 'game', elapsedMs: 25_000 },
      { sessionId: 'aaaaaaaa-1111', gezelId: 'voorman', projectId: 'game', elapsedMs: 125_000 },
    ];

    expect(shouldDeferSoftWatchdog(inflight)).toBe(true);
    expect(summarizeInflightTurnsForLog(inflight)).toBe(
      'voorman/aaaaaaaa in game for 125s (+1 more)',
    );
  });

  it('does not defer for only stale inflight turns', () => {
    expect(
      shouldDeferSoftWatchdog([
        { sessionId: 'aaaaaaaa-1111', gezelId: 'voorman', projectId: 'game', elapsedMs: 241_000 },
      ]),
    ).toBe(false);
  });

  it('MLX gets a larger in-flight defer cap than the CUDA/llama-cpp default', () => {
    expect(inflightDeferMsForEngine('mlx')).toBe(20 * 60 * 1000);
    expect(inflightDeferMsForEngine('llama-cpp')).toBe(4 * 60 * 1000);
    expect(inflightDeferMsForEngine(undefined)).toBe(4 * 60 * 1000);
  });

  it('the STALL retry-loop path defers while a slow turn is still streaming', () => {
    // incident-postmortem / qwen3.6-27b-q8, 2026-08-01: failed as "stalled 18m
    // ... 0 re-writes" at 04:23:17 while the engine was 2,275 tokens into a
    // turn at 4.62 t/s that released 1.6s later. One repair turn on a 27B at
    // ~5 t/s legitimately runs 8-11 min, past the 4-min llama-cpp cap.
    const midTurn = [
      {
        sessionId: 'dddddddd-4444',
        gezelId: 'jordan',
        projectId: 'checkout',
        elapsedMs: 8 * 60_000,
      },
    ];
    const base = {
      fastPathTripped: false,
      longPathTripped: false,
      chatterPathTripped: false,
      inflightTurns: midTurn,
      inflightDeferMs: inflightDeferMsForEngine('llama-cpp'),
    };
    expect(shouldDeferRetryLoopForInflight({ ...base, stallPathTripped: true })).toBe(true);
    // The same 8-min turn under the LONG path keeps the old 4-min budget.
    expect(
      shouldDeferRetryLoopForInflight({
        ...base,
        stallPathTripped: false,
        longPathTripped: true,
      }),
    ).toBe(false);
  });

  it('count-based retry-loop paths never defer for an in-flight turn', () => {
    // FAST and CHATTER carry a count component, so they are throughput-
    // invariant: a model that re-wrote N times without moving the sniff is
    // looping at any decode speed. Deferring them would let a real loop ride.
    const freshTurn = [
      { sessionId: 'eeeeeeee-5555', gezelId: 'priya', projectId: 'orders', elapsedMs: 10_000 },
    ];
    const base = {
      longPathTripped: false,
      stallPathTripped: false,
      inflightTurns: freshTurn,
      inflightDeferMs: inflightDeferMsForEngine('llama-cpp'),
    };
    expect(
      shouldDeferRetryLoopForInflight({
        ...base,
        fastPathTripped: true,
        chatterPathTripped: false,
      }),
    ).toBe(false);
    expect(
      shouldDeferRetryLoopForInflight({
        ...base,
        fastPathTripped: false,
        chatterPathTripped: true,
      }),
    ).toBe(false);
    // A stall that co-trips with a count-based path still fails fast.
    expect(
      shouldDeferRetryLoopForInflight({
        ...base,
        stallPathTripped: true,
        fastPathTripped: true,
        chatterPathTripped: false,
      }),
    ).toBe(false);
  });

  it('a genuinely wedged turn past the stall budget still fails the trial', () => {
    // The deferral is not unbounded — a turn stuck 20 min is past the 15-min
    // stall budget and the HARD progress watchdog stays the real backstop.
    const wedged = [
      {
        sessionId: 'ffffffff-6666',
        gezelId: 'jordan',
        projectId: 'checkout',
        elapsedMs: 20 * 60_000,
      },
    ];
    expect(
      shouldDeferRetryLoopForInflight({
        fastPathTripped: false,
        longPathTripped: false,
        stallPathTripped: true,
        chatterPathTripped: false,
        inflightTurns: wedged,
        inflightDeferMs: inflightDeferMsForEngine('llama-cpp'),
      }),
    ).toBe(false);
  });

  it('a 10-min MLX prefill still defers under the MLX cap but not the default', () => {
    // gemma4-31b on tool-routing-retrieval: a 45K-token prefill sat mid-turn
    // ~10 min before the first token and was false-killed under the 4-min cap.
    const prefilling = [
      {
        sessionId: 'cccccccc-3333',
        gezelId: 'developer',
        projectId: 'winkelwagen',
        elapsedMs: 602_000,
      },
    ];
    expect(shouldDeferSoftWatchdog(prefilling)).toBe(false); // 4-min default → false-kill
    expect(shouldDeferSoftWatchdog(prefilling, inflightDeferMsForEngine('mlx'))).toBe(true); // 20-min cap → survives
  });
});

describe('poisoned-session recovery', () => {
  it('picks recent non-meester sessions with a last turn error', () => {
    const picked = pickPoisonedSessionsForRecovery(
      [
        {
          id: 'meester-session',
          gezelId: 'meester',
          projectId: 'default',
          lastTurnError: 'abort',
          lastActivityAt: '2026-06-28T10:00:00.000Z',
        },
        {
          id: 'old-builder',
          gezelId: 'builder',
          projectId: 'game',
          lastTurnError: '  old abort  ',
          lastActivityAt: '2026-06-28T10:01:00.000Z',
        },
        {
          id: 'new-builder',
          gezelId: 'builder',
          projectId: 'game',
          lastTurnError: 'new abort',
          lastActivityAt: '2026-06-28T10:03:00.000Z',
        },
        {
          id: 'archived-builder',
          gezelId: 'builder',
          projectId: 'game',
          archived: true,
          lastTurnError: 'archived abort',
          lastActivityAt: '2026-06-28T10:04:00.000Z',
        },
      ],
      'meester',
    );

    expect(picked.map((session) => session.sessionId)).toEqual(['new-builder', 'old-builder']);
    expect(picked[1]?.lastTurnError).toBe('old abort');
  });

  it('builds a direct edit recovery prompt for line-edit aborts', () => {
    const message = buildPoisonedSessionRecoveryMessage({
      lastTurnError: '`replace_lines` failed 5 times in a row',
      filePath: 'server.mjs',
      sniff: {
        key: 'server.mjs',
        score: 6,
        bytes: 16887,
        failReason: 'contract-test-passes: GET /books pagination.limit is not a number',
      },
    });

    expect(message).toContain('[eval recovery]');
    expect(message).toContain('replace_lines');
    expect(message).toContain('score 6');
    expect(message).toContain('pagination.limit');
    expect(message).toContain('repair `server.mjs`');
    expect(message).toContain('use `write_file`');
    expect(message).toContain('Do not answer only in prose');
  });

  it('prefers a targeted patch when an existing checked file exposes a new validator failure', () => {
    const message = buildPoisonedSessionRecoveryMessage({
      lastTurnError:
        'source edit turn ended without a successful workspace mutation after corrective nudges',
      filePath: 'src/machine.ts',
      sniff: {
        key: 'source-repair',
        score: 2,
        bytes: 3194,
        failReason: "expected 'draft' to be 'pending'",
      },
    });

    expect(message).toContain('smallest targeted repair');
    expect(message).toContain('`replace_in_file` or `replace_lines`');
    expect(message).toContain(
      "Preserve the file's existing public exports, signatures, state shape",
    );
    expect(message).toContain('Do not replace the complete file');
    expect(message).not.toContain('`write_file`');
  });

  it('uses a complete write when the checked file is missing', () => {
    const message = buildPoisonedSessionRecoveryMessage({
      lastTurnError: 'deliverable file was not found',
      filePath: 'src/new-module.ts',
      sniff: { key: 'source-repair', score: 0, bytes: 0, failReason: 'missing deliverable' },
    });

    expect(message).toContain('use `write_file` to write a complete corrected version');
    expect(message).not.toContain('smallest targeted repair');
  });

  it('builds a task-graph recovery prompt for ungated plan steps', () => {
    const failReason =
      'draft plan-eval/1 has ungated build steps: implement, design-ui-ux-and-wireframe';
    const line = taskGraphPoisonedSessionRecoveryLine(failReason);
    const message = buildPoisonedSessionRecoveryMessage({
      lastTurnError: 'The model failed tool calls 5 times in a row',
      sniff: {
        key: 'task-graph.md',
        score: 4,
        bytes: 1770,
        failReason,
      },
    });

    expect(line).toContain('task-graph repair');
    expect(line).toContain(
      'set_step_deliverable({ task: "plan-eval/1", stepId: "implement", path: "index.html", kind: "html-page" })',
    );
    expect(line).toContain(
      'set_step_deliverable({ task: "plan-eval/1", stepId: "design-ui-ux-and-wireframe", path: "index.html", kind: "html-page" })',
    );
    expect(message).toContain('Do not call `set_task_status`');
    expect(message).not.toContain('workspace deliverable');
    expect(message).not.toContain('write_file` for recovery');
  });

  it('infers a concrete recovery file from generic scenario fail reasons', () => {
    expect(recoveryFilePathForSniff({ key: 'constrained-comms' })).toBe('customer-notice.md');
    expect(recoveryFilePathForSniff({ key: 'data-wrangle' })).toBe('out/customers.json');
    expect(
      recoveryFilePathForSniff({
        key: 'bookstore',
        failReason: 'contract-test-passes: contract-test.mjs builds fetch URLs with an empty port',
      }),
    ).toBe('contract-test.mjs');
    expect(
      recoveryFilePathForSniff({
        key: 'bookstore',
        failReason: 'contract-test-passes: evaluator smoke failed: GET /books?limit=2 got 5',
      }),
    ).toBe('server.mjs');
    expect(
      recoveryFilePathForSniff({
        key: 'bookstore',
        failReason: 'auth-on-mutations: bearerAuth missing on POST /books',
      }),
    ).toBe('openapi.yaml');
  });

  it('prefers an explicit directory-qualified repair file over scenario and reason inference', () => {
    expect(
      recoveryFilePathForSniff({
        key: 'bookstore',
        failReason: 'auth-on-mutations: bearerAuth is missing from openapi.yaml',
        repairFilePath: 'src/store.ts',
      }),
    ).toBe('src/store.ts');
  });

  it('rejects an unsafe explicit repair file before using the existing safe fallback', () => {
    expect(
      recoveryFilePathForSniff({
        key: 'symptom-debug',
        repairFilePath: '../outside.ts',
      }),
    ).toBe('lib/paginate.mjs');
  });

  it('distinguishes a stale first poison from an abort after recovery', () => {
    const tracker = new PoisonedSessionRecoveryTracker();
    const first = {
      sessionId: 'builder-session',
      gezelId: 'builder',
      projectId: 'game',
      lastTurnError: 'direct file-work turn ended without a mutation',
    };

    tracker.markAttempted(first);
    expect(tracker.observe([first])).toEqual([]); // stale error immediately after dispatch
    expect(tracker.observe([])).toEqual([]); // recovery turn cleared the poison

    const second = { ...first, lastTurnError: 'source edit turn aborted after repair' };
    expect(tracker.observe([second])).toEqual([second]);
  });

  it('detects a changed second abort even when it happens between polling intervals', () => {
    const tracker = new PoisonedSessionRecoveryTracker();
    const first = {
      sessionId: 'builder-session',
      gezelId: 'builder',
      projectId: 'game',
      lastTurnError: 'first abort',
    };
    tracker.markAttempted(first);

    expect(tracker.observe([{ ...first, lastTurnError: 'second abort' }])).toHaveLength(1);
  });

  it('detects an identical symptom-repair abort from newer session activity', () => {
    const tracker = new PoisonedSessionRecoveryTracker();
    const first = {
      sessionId: 'builder-session',
      gezelId: 'builder',
      projectId: 'game',
      lastTurnError: 'source edit turn ended without a mutation',
      lastActivityAt: '2026-07-10T15:45:14.000Z',
    };
    const checkpoint = { score: 1, bytes: 1193 };
    tracker.markAttempted(first, checkpoint);

    // The HTTP dispatch accepts immediately and the recovery can fail with
    // exactly the same stable provider message. The later session timestamp
    // distinguishes that new turn from the stale poison; the poller's
    // in-flight snapshot decides whether it is safe to terminate yet.
    expect(
      tracker.observe([{ ...first, lastActivityAt: '2026-07-10T15:45:33.860Z' }], checkpoint),
    ).toHaveLength(1);
  });

  it('re-arms schema-style phased repair after strictly higher checked progress', () => {
    const tracker = new PoisonedSessionRecoveryTracker();
    const first = {
      sessionId: 'builder-session',
      gezelId: 'builder',
      projectId: 'migration',
      lastTurnError: 'source edit turn ended without a mutation',
    };

    const typesCheckpoint = {
      score: 1,
      bytes: 2746,
      failReason: 'types contract still uses the legacy shape',
    };
    const storeCheckpoint = {
      score: 2,
      bytes: 2564,
      failReason: 'store contract still uses the legacy shape',
    };
    tracker.markAttempted(first, typesCheckpoint);
    expect(tracker.observe([first], typesCheckpoint)).toEqual([]); // stale first poison

    // The recovery landed a validated gate and moved the task to its next
    // phase. Even an identical provider error now gets one recovery at the
    // new checkpoint rather than terminating the whole multi-file task.
    expect(tracker.observe([{ ...first }], storeCheckpoint)).toEqual([]);
    expect(tracker.hasAttempted(first.sessionId)).toBe(false);

    tracker.markAttempted(first, storeCheckpoint);
    expect(tracker.observe([], storeCheckpoint)).toEqual([]); // second recovery cleared it
    expect(tracker.observe([first], storeCheckpoint)).toEqual([first]); // bounded without progress
  });

  it('re-arms after symptom-style checked progress rises despite a larger failing rewrite', () => {
    const tracker = new PoisonedSessionRecoveryTracker();
    const first = {
      sessionId: 'debugger-session',
      gezelId: 'debugger',
      projectId: 'pagination',
      lastTurnError: 'source edit turn ended without a mutation',
    };
    const boundaryFailure = {
      score: 1,
      bytes: 1193,
      failReason: 'acceptance CASE 3 expected a4 got a5',
    };
    tracker.markAttempted(first, boundaryFailure);

    expect(
      tracker.observe([first], {
        score: 2,
        bytes: 2416,
        failReason: 'acceptance script now crashes in the exported function',
      }),
    ).toEqual([]);
    expect(tracker.hasAttempted(first.sessionId)).toBe(false);
  });

  it('re-arms once for same-score semantic progress, then caps the checkpoint', () => {
    const tracker = new PoisonedSessionRecoveryTracker();
    const first = {
      sessionId: 'builder-session',
      gezelId: 'builder',
      projectId: 'state-machine',
      lastTurnError: 'source edit turn ended without a mutation',
    };
    const firstFailure = {
      score: 2,
      bytes: 3194,
      failReason: "expected 'draft' to be 'pending' 3ms",
    };
    const nextFailure = {
      score: 2,
      bytes: 2074,
      failReason: 'm.send is not a function 2ms',
    };

    tracker.markAttempted(first, firstFailure);
    expect(tracker.observe([], firstFailure)).toEqual([]);
    expect(tracker.observe([first], nextFailure)).toEqual([]);
    expect(tracker.hasAttempted(first.sessionId)).toBe(false);

    tracker.markAttempted(first, nextFailure); // second and final recovery at score 2
    expect(tracker.observe([], nextFailure)).toEqual([]);
    expect(
      tracker.observe([first], {
        score: 2,
        bytes: 2300,
        failReason: 'history entries have the wrong shape',
      }),
    ).toEqual([first]);
    expect(tracker.hasAttempted(first.sessionId)).toBe(true);
  });

  it('does not re-arm same-score recovery for byte-only churn', () => {
    const tracker = new PoisonedSessionRecoveryTracker();
    const first = {
      sessionId: 'builder-session',
      gezelId: 'builder',
      projectId: 'service',
      lastTurnError: 'first abort',
    };
    const checkpoint = { score: 2, bytes: 2000, failReason: 'same validator failure' };
    tracker.markAttempted(first, checkpoint);
    expect(tracker.observe([], checkpoint)).toEqual([]);
    expect(tracker.observe([first], { ...checkpoint, bytes: 2400 })).toEqual([first]);
  });

  it('does not re-arm same-score recovery for failure-only or timing-only churn', () => {
    const first = {
      sessionId: 'builder-session',
      gezelId: 'builder',
      projectId: 'service',
      lastTurnError: 'first abort',
    };

    const failureOnly = new PoisonedSessionRecoveryTracker();
    const checkpoint = { score: 2, bytes: 2000, failReason: 'first concrete failure 3ms' };
    failureOnly.markAttempted(first, checkpoint);
    expect(failureOnly.observe([], checkpoint)).toEqual([]);
    expect(
      failureOnly.observe([first], { ...checkpoint, failReason: 'different concrete failure 2ms' }),
    ).toEqual([first]);

    const timingOnly = new PoisonedSessionRecoveryTracker();
    timingOnly.markAttempted(first, checkpoint);
    expect(timingOnly.observe([], checkpoint)).toEqual([]);
    expect(
      timingOnly.observe([first], {
        ...checkpoint,
        bytes: 2100,
        failReason: 'first concrete failure 9ms',
      }),
    ).toEqual([first]);
    expect(poisonedRecoveryFailureFingerprint('first concrete failure 3ms')).toBe(
      poisonedRecoveryFailureFingerprint('first concrete failure 9ms'),
    );
  });

  it('does not re-arm after score regression even when bytes and failure change', () => {
    const tracker = new PoisonedSessionRecoveryTracker();
    const first = {
      sessionId: 'builder-session',
      gezelId: 'builder',
      projectId: 'service',
      lastTurnError: 'first abort',
    };
    const checkpoint = { score: 2, bytes: 2000, failReason: 'first failure' };
    tracker.markAttempted(first, checkpoint);
    expect(tracker.observe([], checkpoint)).toEqual([]);
    expect(
      tracker.observe([first], { score: 1, bytes: 2500, failReason: 'regressed failure' }),
    ).toEqual([first]);
  });

  it('dispatches poison recovery only with a reliable idle-session snapshot', () => {
    expect(canDispatchPoisonedSessionRecovery(null, 'builder-session')).toBe(false);
    expect(
      canDispatchPoisonedSessionRecovery(
        [
          {
            sessionId: 'builder-session',
            gezelId: 'builder',
            projectId: 'game',
            elapsedMs: 10 * 60_000,
          },
        ],
        'builder-session',
      ),
    ).toBe(false);
    expect(
      canDispatchPoisonedSessionRecovery(
        [
          {
            sessionId: 'other-session',
            gezelId: 'reviewer',
            projectId: 'game',
            elapsedMs: 500,
          },
        ],
        'builder-session',
      ),
    ).toBe(true);
  });

  it('classifies a repeated recovery abort as a clear model-stuck failure', () => {
    const failure = repeatedPoisonedSessionFailure({
      sessionId: 'bbbbbbbb-2222',
      gezelId: 'theo',
      projectId: 'pagination-service',
      lastTurnError: 'source edit turn ended without a successful workspace mutation',
    });

    expect(failure.failureMode).toBe('model-stuck');
    expect(failure.reason).toContain('repair-aborted: theo/bbbbbbbb');
    expect(failure.reason).toContain(
      'exhausted its bounded automatic recovery allowance at the current checked progress',
    );
  });
});

describe('re-engage nudge state', () => {
  it('requests a targeted repair when a checked file already exists', () => {
    const nudge = buildReEngageNudge({
      downstream: true,
      sniff: {
        key: 'symptom-debug',
        score: 1,
        bytes: 1193,
        failReason: 'node accept.mjs still failing: CASE 3 expected a4 got a5',
      },
    });

    expect(nudge.filePath).toBe('lib/paginate.mjs');
    expect(nudge.text).toContain('existing checked workspace file');
    expect(nudge.text).toContain('1193 bytes');
    expect(nudge.text).toContain('CASE 3 expected a4 got a5');
    expect(nudge.text).toContain('replace_in_file');
    expect(nudge.text).toContain('Do NOT recreate');
    expect(nudge.text).not.toContain("deliverable hasn't landed");
    expect(nudge.text).not.toContain('creating the actual deliverable');
  });

  it('reserves the create-file directive for a missing or zero-byte deliverable', () => {
    const nudge = buildReEngageNudge({
      downstream: true,
      sniff: { key: 'review.md', score: 0, bytes: 0 },
    });

    expect(nudge.text).toContain("deliverable hasn't landed");
    expect(nudge.text).toContain('write_file');
    expect(nudge.text).toContain('creating the actual deliverable');
  });
});

describe('llamaCppEvalLaunchOverridesForModel', () => {
  it('does not override ordinary runnable local models', () => {
    expect(llamaCppEvalLaunchOverridesForModel('qwen3.6-35b-a3b-q4')).toBeUndefined();
    expect(llamaCppEvalLaunchOverridesForModel('imaginary-119b-q4')).toBeUndefined();
  });

  it('uses catalog size metadata for frontier models not named by the old size allowlist', () => {
    expect(llamaCppEvalLaunchOverridesForModel('qwen3.5-122b-a10b-q4')).toBeDefined();
  });

  it('caps context and concurrency for 120B+ local eval models', () => {
    const actual = llamaCppEvalLaunchOverridesForModel('mistral-medium-3.5-128b-q4');

    expect(actual?.extraEnv).toMatchObject({
      GEZEL_LLAMA_NUM_CTX: '65536',
      GEZEL_LLAMA_STARTUP_TIMEOUT_MS: '900000',
      GEZEL_LLAMA_PRE_FIRST_BYTE_TIMEOUT_MS: '900000',
      GEZEL_CAPACITY_BUDGET_GB: '110',
    });
    expect(actual?.config).toMatchObject({
      providerConcurrency: { 'llama-cpp': 1 },
      llamaCppKvCacheType: 'q4_0',
    });
    expect(actual?.config).not.toHaveProperty('modelTuning');
    expect(actual?.minTrialTimeoutMs).toBe(60 * 60_000);
    expect(actual?.hardProgressTimeoutMs).toBe(45 * 60_000);
    expect(actual?.summary).toContain('tuning=catalog');
    expect(actual?.summary).toContain('numCtx=65536');
    expect(actual?.summary).toContain('hardProgressTimeout=45m');
    expect(actual?.summary).toContain('minTrialTimeout=60m');
  });
});

describe('ds4 eval residency policy', () => {
  const GB = 1024 ** 3;

  it('keeps capability tuning in the catalog manifest', () => {
    const actual = ds4EvalLaunchOverridesForModel('deepseek-v4-flash-284b-q2');

    expect(actual?.config).toMatchObject({
      providerConcurrency: { ds4: 1 },
      ds4NumCtx: 131072,
    });
    expect(actual?.config).not.toHaveProperty('modelTuning');
    expect(actual?.summary).toContain('tuning=catalog');
    expect(actual?.summary).not.toContain('maxTokens=4096');
    expect(actual?.summary).not.toContain('thinking=off');
  });

  it('loads Q2-sized weights fully on 128 GB-class unified-memory eval hosts', () => {
    expect(
      ds4EvalShouldUseSsdStreaming({
        totalRamBytes: 128 * GB,
        modelSizeBytes: 81 * GB,
        platform: 'linux',
        arch: 'arm64',
      }),
    ).toBe(false);
  });

  it('retains streaming for Q4-sized weights, smaller hosts, unknown sizes, and discrete GPUs', () => {
    expect(
      ds4EvalShouldUseSsdStreaming({
        totalRamBytes: 128 * GB,
        modelSizeBytes: 153 * GB,
        platform: 'darwin',
        arch: 'arm64',
      }),
    ).toBe(true);
    expect(
      ds4EvalShouldUseSsdStreaming({
        totalRamBytes: 96 * GB,
        modelSizeBytes: 81 * GB,
        platform: 'linux',
        arch: 'arm64',
      }),
    ).toBe(true);
    expect(
      ds4EvalShouldUseSsdStreaming({
        totalRamBytes: 256 * GB,
        modelSizeBytes: 81 * GB,
        platform: 'linux',
        arch: 'x64',
      }),
    ).toBe(true);
    expect(
      ds4EvalShouldUseSsdStreaming({
        totalRamBytes: 256 * GB,
        platform: 'darwin',
        arch: 'arm64',
      }),
    ).toBe(true);
  });
});

describe('localEvalDeviceSafetyConfig', () => {
  it('defaults unattended local evals to guarded single-slot llama.cpp', () => {
    expect(localEvalDeviceSafetyConfig('llama-cpp', {})).toEqual({
      deviceSafety: { mode: 'guard', onTelemetryFailure: 'allow' },
      providerConcurrency: { 'llama-cpp': 1 },
      llamaCppUbatchSize: 512,
    });
  });

  it('supports an explicit observe/off escape hatch without workload overrides', () => {
    expect(
      localEvalDeviceSafetyConfig('llama-cpp', { GEZEL_EVAL_DEVICE_SAFETY: 'observe' }),
    ).toEqual({ deviceSafety: { mode: 'observe', onTelemetryFailure: 'allow' } });
    expect(localEvalDeviceSafetyConfig('openai', {})).toEqual({});
  });

  it('can fail closed when an unattended host requires telemetry', () => {
    expect(
      localEvalDeviceSafetyConfig('mlx', {
        GEZEL_EVAL_DEVICE_SAFETY: 'guard',
        GEZEL_EVAL_DEVICE_SAFETY_TELEMETRY_FAILURE: 'block',
      }),
    ).toEqual({
      deviceSafety: { mode: 'guard', onTelemetryFailure: 'block' },
      providerConcurrency: { mlx: 1 },
    });
  });
});

describe('defaultSoftProgressTimeoutMsForModel', () => {
  it('keeps ordinary models on the default five-minute soft watchdog', () => {
    expect(defaultSoftProgressTimeoutMsForModel('gemma4-31b-q4')).toBe(5 * 60 * 1000);
    expect(defaultSoftProgressTimeoutMsForModel('qwen3.6-35b-a3b-q4')).toBe(5 * 60 * 1000);
  });

  it('allows longer cold-start silence for very large local models', () => {
    expect(defaultSoftProgressTimeoutMsForModel('nemotron3-super-120b-q4')).toBe(12 * 60 * 1000);
    expect(defaultSoftProgressTimeoutMsForModel('qwen3.5-122b-a10b-q4')).toBe(12 * 60 * 1000);
    expect(defaultSoftProgressTimeoutMsForModel('mistral-medium-3.5-128b-q4')).toBe(12 * 60 * 1000);
    expect(defaultSoftProgressTimeoutMsForModel('deepseek-v4-flash-284b-q2')).toBe(12 * 60 * 1000);
  });

  it('uses an intermediate window for 70B-class models', () => {
    expect(defaultSoftProgressTimeoutMsForModel('llama-3.3-70b-q4')).toBe(8 * 60 * 1000);
  });

  it('doubles the window for MLX (slower Apple-Silicon first-turn decode)', () => {
    // The throughput artifact this guards against: qwen3.6-27b-q4 /
    // gemma4-31b-q4 first-turn landed at ~459s on bookstore-openapi, past the
    // 5-min default but inside the doubled 10-min MLX window.
    expect(defaultSoftProgressTimeoutMsForModel('qwen3.6-27b-q4', 'mlx')).toBe(10 * 60 * 1000);
    expect(defaultSoftProgressTimeoutMsForModel('gemma4-31b-q4', 'mlx')).toBe(10 * 60 * 1000);
    expect(defaultSoftProgressTimeoutMsForModel('llama-3.3-70b-q4', 'mlx')).toBe(16 * 60 * 1000);
    expect(defaultSoftProgressTimeoutMsForModel('nemotron3-super-120b-q4', 'mlx')).toBe(
      24 * 60 * 1000,
    );
  });

  it('leaves llama-cpp / unspecified engine on the tuned defaults', () => {
    expect(defaultSoftProgressTimeoutMsForModel('qwen3.6-27b-q4', 'llama-cpp')).toBe(5 * 60 * 1000);
    expect(defaultSoftProgressTimeoutMsForModel('qwen3.6-27b-q4')).toBe(5 * 60 * 1000);
  });

  it('lifts the silence floor to 20m for self-orchestrating providers (silence ≠ hang)', () => {
    // codex-cli tankcombat false-failed at the 5m default mid-invocation;
    // these providers run a whole agent loop per gezel-turn and go silent.
    expect(defaultSoftProgressTimeoutMsForModel('gpt-5.5', 'codex-cli')).toBe(20 * 60 * 1000);
    expect(defaultSoftProgressTimeoutMsForModel('claude-sonnet-4.6', 'anthropic-cli')).toBe(
      20 * 60 * 1000,
    );
    expect(defaultSoftProgressTimeoutMsForModel('claude-sonnet-4.6', 'copilot')).toBe(
      20 * 60 * 1000,
    );
  });

  it('keeps the floor as a floor — a larger size-based window still wins', () => {
    // A 120B-class self-orchestrating model: max(12m, 20m) = 20m here, but the
    // floor must never SHRINK an already-larger window.
    expect(defaultSoftProgressTimeoutMsForModel('some-284b-model', 'codex-cli')).toBe(
      20 * 60 * 1000,
    );
  });

  it('does not lift raw cloud providers (gezel drives their loop, one turn per step)', () => {
    expect(defaultSoftProgressTimeoutMsForModel('gpt-5', 'openai')).toBe(5 * 60 * 1000);
    expect(defaultSoftProgressTimeoutMsForModel('claude-sonnet-4-6', 'anthropic')).toBe(
      5 * 60 * 1000,
    );
  });
});

describe('readCapacityDenialFromLog', () => {
  it('extracts capacity broker denials from daemon logs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gezel-runner-test-'));
    const logPath = join(dir, 'daemon.log');
    try {
      await writeFile(
        logPath,
        [
          '2026-06-05T04:04:21.752Z WARN [engine-router] bind failed',
          'capacity broker denied llama-cpp:mistral-medium-3.5-128b-q4:0: budget exhausted: would commit 89876566963 against 78357907046',
        ].join('\n'),
      );
      expect(readCapacityDenialFromLog(logPath)).toBe(
        'capacity broker denied llama-cpp:mistral-medium-3.5-128b-q4:0: budget exhausted: would commit 89876566963 against 78357907046',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null for missing logs and unrelated log text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gezel-runner-test-'));
    const logPath = join(dir, 'daemon.log');
    try {
      expect(readCapacityDenialFromLog(join(dir, 'missing.log'))).toBeNull();
      await writeFile(logPath, 'ordinary startup log\n');
      expect(readCapacityDenialFromLog(logPath)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('readContextOverflowFromLog', () => {
  it('extracts actionable provider context-overflow messages', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gezel-context-overflow-'));
    const logPath = join(dir, 'daemon.log');
    try {
      await writeFile(
        logPath,
        'ERROR [chat] error:\nOn-device model ran out of working memory: 13,426 tokens needed but only 8,192 available. Try asking a narrower question.\n',
      );
      expect(readContextOverflowFromLog(logPath)).toBe(
        'On-device model ran out of working memory: 13,426 tokens needed but only 8,192 available. Try asking a narrower question.',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to raw llama-server context-overflow lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gezel-context-overflow-'));
    const logPath = join(dir, 'daemon.log');
    try {
      await writeFile(
        logPath,
        'send_error: task id = 0, error: request (13426 tokens) exceeds the available context size (8192 tokens), try increasing it\n',
      );
      expect(readContextOverflowFromLog(logPath)).toBe(
        'context overflow: 13426 tokens needed but only 8192 available',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('sniffKeyToWorkspaceFilePath', () => {
  it('extracts the workspace file path from plain and suffixed sniff keys', () => {
    expect(sniffKeyToWorkspaceFilePath('review.md')).toBe('review.md');
    expect(sniffKeyToWorkspaceFilePath('review.md:near-miss:workspace')).toBe('review.md');
    expect(sniffKeyToWorkspaceFilePath('index.html:6:4:rp0:rf1')).toBe('index.html');
    expect(sniffKeyToWorkspaceFilePath('workspace/index.html')).toBe('index.html');
    expect(sniffKeyToWorkspaceFilePath('tic-tac-toe-game/workspace/index.html')).toBe('index.html');
    expect(sniffKeyToWorkspaceFilePath('project-a/workspace/public/index.html')).toBe(
      'public/index.html',
    );
  });

  it('maps coarse scenario sniff keys to their expected workspace files', () => {
    expect(sniffKeyToWorkspaceFilePath('constrained-comms')).toBe('customer-notice.md');
    expect(sniffKeyToWorkspaceFilePath('fictional-sdk')).toBe('worker.mjs');
    expect(sniffKeyToWorkspaceFilePath('failing-tests-spec')).toBe('src/machine.ts');
  });

  it('ignores non-file and suspicious sniff keys', () => {
    expect(sniffKeyToWorkspaceFilePath('squisq-repo:fetched')).toBeNull();
    expect(sniffKeyToWorkspaceFilePath('../review.md')).toBeNull();
    expect(sniffKeyToWorkspaceFilePath('/tmp/review.md')).toBeNull();
    expect(sniffKeyToWorkspaceFilePath(null)).toBeNull();
  });
});

describe('retryLoopSniffKey', () => {
  it('does not advance for same-score byte churn', () => {
    const a = retryLoopSniffKey({ key: 'codebase-evolution', score: 107, bytes: 8003 });
    const b = retryLoopSniffKey({ key: 'codebase-evolution', score: 107, bytes: 8480 });

    expect(a).toBe(b);
  });

  it('advances when runtime assertion counters change', () => {
    const a = retryLoopSniffKey({
      key: 'index.html',
      score: 8,
      bytes: 4200,
      runtimeFailed: 1,
    });
    const b = retryLoopSniffKey({
      key: 'index.html',
      score: 8,
      bytes: 4200,
      runtimeFailed: 2,
    });

    expect(a).not.toBe(b);
  });

  it('advances when the failure reason changes', () => {
    const a = retryLoopSniffKey({
      key: 'bookstore',
      score: 6,
      bytes: 11_393,
      failReason: 'contract-test-passes: require is not defined in ES module scope',
    });
    const b = retryLoopSniffKey({
      key: 'bookstore',
      score: 6,
      bytes: 12_084,
      failReason:
        'contract-test-passes: evaluator smoke failed: GET /books expected 5 books, got 2',
    });

    expect(a).not.toBe(b);
  });

  it('does not advance for numeric-only failure reason churn', () => {
    const a = retryLoopSniffKey({
      key: 'index.html',
      score: 8,
      bytes: 3331,
      failReason: 'HTML is 3331 bytes; add at least 2 features',
    });
    const b = retryLoopSniffKey({
      key: 'index.html',
      score: 8,
      bytes: 4041,
      failReason: 'HTML is 4041 bytes; add at least 2 features',
    });

    expect(a).toBe(b);
  });
});

describe('sniffArtifactHasScored', () => {
  it('keeps first-write score-0 sniffs exempt from scored-artifact retry paths', () => {
    expect(sniffArtifactHasScored({ key: 'bookstore', score: 0 }, new Set())).toBe(false);
  });

  it('treats a score-0 regression as an existing artifact once that sniff key scored', () => {
    expect(sniffArtifactHasScored({ key: 'bookstore', score: 0 }, new Set(['bookstore']))).toBe(
      true,
    );
  });

  it('does not carry scored state across unrelated sniff keys', () => {
    expect(
      sniffArtifactHasScored({ key: 'schema-migration', score: 0 }, new Set(['bookstore'])),
    ).toBe(false);
  });
});
