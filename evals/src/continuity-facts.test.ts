import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  dedupeHistoryEvents,
  summarizeContinuity,
  summarizeContinuityForRunDir,
} from './continuity-facts.ts';

const at = (s: number) => new Date(Date.UTC(2026, 8, 18, 10, 0, s)).toISOString();

const EVENTS = [
  { id: 'e1', kind: 'task.step.activated', at: at(0), details: { ref: 'p/1', stepId: 'a' } },
  {
    id: 'e2',
    kind: 'tool.called',
    at: at(1),
    details: { sessionId: 'S1', taskRef: 'p/1', stepId: 'a', name: 'read_file' },
  },
  {
    id: 'e3',
    kind: 'task.step.gated',
    at: at(2),
    details: { ref: 'p/1', stepId: 'a', decision: 'reject', attempt: 1 },
  },
  {
    id: 'e4',
    kind: 'task.step.gated',
    at: at(3),
    details: { ref: 'p/1', stepId: 'a', decision: 'approve', attempt: 2 },
  },
  {
    id: 'e5',
    kind: 'task.step.completed',
    at: at(4),
    details: { ref: 'p/1', stepId: 'a', nextStepId: 'b' },
  },
  { id: 'e6', kind: 'task.step.activated', at: at(4), details: { ref: 'p/1', stepId: 'b' } },
  {
    id: 'e7',
    kind: 'tool.called',
    at: at(5),
    details: { sessionId: 'S1', taskRef: 'p/1', stepId: 'b', name: 'write_file' },
  },
  {
    id: 'e8',
    kind: 'task.step.completed',
    at: at(10),
    details: { ref: 'p/1', stepId: 'b', nextStepId: null },
  },
  { id: 'e9', kind: 'chat.compacted', at: at(6), details: { removedCount: 4, compactionCount: 1 } },
  {
    id: 'e10',
    kind: 'task.instance.spawned',
    at: at(7),
    details: { parentRef: 'p/1', childRef: 'p/2' },
  },
  {
    id: 'e11',
    kind: 'task.instance.spawned',
    at: at(7),
    details: { parentRef: 'p/1', childRef: 'p/3' },
  },
  {
    id: 'e12',
    kind: 'task.step.redriven',
    at: at(8),
    details: { ref: 'p/2', stepId: 'w', attempt: 1, maxRedrives: 2 },
  },
  {
    id: 'e13',
    kind: 'tool.called',
    at: at(9),
    details: { sessionId: 'S2', taskRef: 'p/2', stepId: 'w', name: 'write_file' },
  },
];

const SESSIONS = [
  {
    id: 'S1',
    gezelId: 'wren',
    taskRef: 'p/1',
    stepId: 'b',
    messages: [{ role: 'user' }, { role: 'assistant' }, { role: 'user' }],
    contextEstimatedTokens: 30_000,
    contextWindow: 65_536,
  },
  {
    id: 'S2',
    gezelId: 'wren',
    taskRef: 'p/2',
    stepId: 'w',
    messages: [{ role: 'user' }, { role: 'assistant', synthetic: 'context-loop-halt' }],
    resumeFailed: true,
  },
  { id: 'S3', gezelId: 'meester', messages: [{ role: 'user' }] },
];

const LOG = [
  '[tasks] p/1 generalist-mode resolved=generalist setting=on provider=mlx tier=medium requested=auto owner=wren',
  '[tasks] p/2 generalist-mode resolved=generalist setting=on provider=mlx tier=medium requested=auto',
  'pressure#S1000000 COMPACT-START tokens=48000/65536 ratio=0.73 msgs=9',
  'pressure#S1000000 COMPACT-END afterMs=1200 removed=4 ok',
  'pressure#S1000000 COMPACT-START tokens=52000/65536 ratio=0.79 msgs=3',
  'pressure#S1000000 COMPACT-END afterMs=40 removed=0 nope',
  'pressure#S1000000 FORCE-FIT truncated=2 savedChars=9000 (deterministic, no LLM)',
  'pressure#S2000000 FIRST-TURN-PREFIX tokens=50000/65536 ratio=0.76; suppressing start-fresh warning',
  '[chat] deterministic mid-loop compaction for session S1000000 (60000/65536 estimated tokens)',
  '[service] [fanout] p/1 step "draft": spawned 2 child(ren) from tasks/1/items.json',
  '[service] [fanout] p/1 step "collect": holding dispatch — 2 child(ren) still active; will re-dispatch when the last one settles',
  '[tasks] p/1: re-dispatching active step "collect" — last fanout child p/3 settled (complete)',
  '[chat] task-session continuity: reusing S1000000 for p/1 step "a" → "b"; rebuilding the step prompt and exact tool surface',
  '[task-budget] p/2 soft threshold (turns): 20 turns / 9000 out-tok (tier=medium) — converge-now nudge queued',
  '[llama-cpp] aborting — `write_file` was called for the same path 4 times this turn without making progress.',
].join('\n');

const TASKS = [
  { ref: 'p/1', status: 'complete', spawnsCraftbook: { steps: [] } },
  { ref: 'p/2', status: 'complete', parentTaskRef: 'p/1' },
  { ref: 'p/3', status: 'paused', parentTaskRef: 'p/1' },
];

describe('summarizeContinuity', () => {
  const facts = summarizeContinuity({
    result: { generalistMode: 'on', engine: 'mlx' },
    historyEvents: [...EVENTS, EVENTS[1]!],
    sessions: SESSIONS,
    daemonLog: LOG,
    tasks: TASKS,
  });

  it('counts steps, gates and per-step timings from history (deduped by id)', () => {
    expect(facts.steps.activated).toBe(2);
    expect(facts.steps.completed).toBe(2);
    expect(facts.steps.gateRejections).toBe(1);
    expect(facts.steps.gateApprovals).toBe(1);
    expect(facts.steps.redrives).toBe(1);
    const a = facts.steps.perStep.find((s) => s.stepId === 'a')!;
    expect(a.ms).toBe(4000);
    expect(a.gateRejections).toBe(1);
    expect(a.toolCalls).toBe(1);
    expect(a.sessionIds).toEqual(['S1']);
    expect(facts.steps.medianStepMs).toBe(5000);
  });

  it('reads the generalist signature off the session-to-step join', () => {
    expect(facts.sessions.total).toBe(3);
    expect(facts.sessions.taskScoped).toBe(2);
    expect(facts.sessions.reusedAcrossSteps).toBe(1);
    expect(facts.sessions.continuityReuses).toBe(1);
    expect(facts.sessions.continuityBreaks).toBe(0);
    expect(facts.sessions.sessionsPerStep).toBe(1);
    expect(facts.sessions.byGezel).toEqual({ wren: 2, meester: 1 });
    expect(facts.sessions.perTask).toEqual({ 'p/1': 1, 'p/2': 1 });
    expect(facts.sessions.resumeFailures).toBe(1);
    expect(facts.sessions.maxMessages).toBe(3);
    expect(facts.sessions.maxContextFill).toBeCloseTo(30_000 / 65_536, 5);
    expect(facts.resolvedModes).toEqual({ generalist: 2, stepwise: 0 });
    expect(facts.mode).toBe('on');
  });

  it('merges history and log-only compaction signals', () => {
    expect(facts.compaction.observable).toBe(true);
    expect(facts.compaction.betweenTurn).toBe(1);
    expect(facts.compaction.compactStarts).toBe(2);
    expect(facts.compaction.compactFailed).toBe(1);
    expect(facts.compaction.forceFit).toBe(1);
    expect(facts.compaction.midTurn).toBe(1);
    expect(facts.compaction.firstTurnPrefixOver).toBe(1);
    expect(facts.compaction.loopHalts).toBe(1);
    expect(facts.compaction.maxContextFill).toBeCloseTo(52_000 / 65_536, 5);
  });

  it('reports fanout mechanics and budget trips', () => {
    expect(facts.fanout).toEqual({
      hosts: 1,
      childrenSpawned: 2,
      childrenCompleted: 1,
      childrenFailed: 1,
      barrierHolds: 1,
      barrierReleases: 1,
      barrierReleaseFailures: 0,
      skipped: 0,
    });
    expect(facts.budget).toEqual({ taskBudgetSoft: 1, taskBudgetHard: 0, toolRepeatAborts: 1 });
  });

  it('marks compaction unobservable for CLI wrappers and Copilot', () => {
    for (const engine of ['anthropic-cli', 'codex-cli', 'copilot']) {
      const cli = summarizeContinuity({
        result: { generalistMode: 'on', engine },
        historyEvents: [],
        sessions: [],
        daemonLog: '',
        tasks: [],
      });
      expect(cli.compaction.observable).toBe(false);
    }
  });

  it('dedupes by id first and by shape when ids are missing', () => {
    const events = [
      { kind: 'x', at: 't', details: { a: 1 } },
      { kind: 'x', at: 't', details: { a: 1 } },
      { id: '1', kind: 'y' },
      { id: '1', kind: 'y' },
    ];
    expect(dedupeHistoryEvents(events)).toHaveLength(2);
  });
});

describe('summarizeContinuityForRunDir', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-continuity-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null for a run dir with nothing to summarize', async () => {
    expect(summarizeContinuityForRunDir(dir, {})).toBeNull();
  });

  it('reads history (root + project mirror), sessions, daemon.log and task state', async () => {
    await writeFile(join(dir, 'history.jsonl'), EVENTS.map((e) => JSON.stringify(e)).join('\n'));
    await mkdir(join(dir, 'project-history'));
    await writeFile(
      join(dir, 'project-history', 'p.jsonl'),
      EVENTS.slice(0, 3)
        .map((e) => JSON.stringify(e))
        .join('\n'),
    );
    await mkdir(join(dir, 'sessions'));
    for (const s of SESSIONS) {
      await writeFile(join(dir, 'sessions', `${s.gezelId}--${s.id}.json`), JSON.stringify(s));
    }
    await writeFile(join(dir, 'daemon.log'), LOG);
    await writeFile(join(dir, 'state.json'), JSON.stringify({ tasks: TASKS }));
    const facts = summarizeContinuityForRunDir(dir, { generalistMode: 'off', engine: 'llama-cpp' });
    expect(facts).not.toBeNull();
    expect(facts!.mode).toBe('off');
    expect(facts!.steps.activated).toBe(2);
    expect(facts!.sessions.total).toBe(3);
    expect(facts!.fanout.childrenSpawned).toBe(2);
    expect(facts!.compaction.forceFit).toBe(1);
  });
});
