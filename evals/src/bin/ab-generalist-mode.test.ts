import { describe, expect, it } from 'vitest';
import type { ContinuityFacts } from '../continuity-facts.ts';
import {
  ARM_LABEL,
  parseArms,
  renderMarkdown,
  resolveAbRepairPolicy,
  summarizeCell,
} from './ab-generalist-mode.ts';

function facts(over: Partial<ContinuityFacts> = {}): ContinuityFacts {
  return {
    mode: 'on',
    engine: 'mlx',
    resolvedModes: { generalist: 1, stepwise: 0 },
    steps: {
      activated: 4,
      activationEvents: 4,
      completed: 4,
      gateApprovals: 4,
      gateRejections: 1,
      redrives: 0,
      perStep: [],
      medianStepMs: 60_000,
    },
    sessions: {
      total: 2,
      taskScoped: 1,
      byGezel: {},
      perTask: {},
      reusedAcrossSteps: 1,
      continuityReuses: 3,
      continuityBreaks: 0,
      sessionsPerStep: 0.25,
      maxMessages: 40,
      maxContextFill: 0.6,
      resumeFailures: 0,
    },
    compaction: {
      observable: true,
      betweenTurn: 2,
      midTurn: 1,
      forceFit: 0,
      compactStarts: 2,
      compactFailed: 0,
      firstTurnPrefixOver: 0,
      loopHalts: 0,
      maxContextFill: 0.7,
    },
    fanout: {
      hosts: 1,
      childrenSpawned: 5,
      childrenCompleted: 5,
      childrenFailed: 0,
      barrierHolds: 1,
      barrierReleases: 1,
      barrierReleaseFailures: 0,
      skipped: 0,
    },
    budget: { taskBudgetSoft: 0, taskBudgetHard: 0, toolRepeatAborts: 0 },
    ...over,
  };
}

describe('parseArms', () => {
  it('defaults to off,on and dedupes', () => {
    expect(parseArms(undefined, false)).toEqual(['off', 'on']);
    expect(parseArms('on,off,on', false)).toEqual(['on', 'off']);
  });
  it('refuses auto unless allowed, and rejects unknown arms', () => {
    expect(() => parseArms('auto,on', false)).toThrow(/measures nothing/);
    expect(parseArms('auto,on', true)).toEqual(['auto', 'on']);
    expect(() => parseArms('flat', false)).toThrow(/unknown arm/);
  });
});

describe('summarizeCell', () => {
  it('aggregates pass rate, medians and continuity counters and raises bug-watch flags', () => {
    const cell = summarizeCell('qwen3.8-27b-q4', 'on', 'fanout-stories', [
      { trialId: 't1', success: true, durationMs: 600_000, continuity: facts() },
      {
        trialId: 't2',
        success: false,
        durationMs: 1_200_000,
        failureMode: 'no-progress',
        failureClass: 'model',
        failureClassRule: 'compaction-loop',
        continuity: facts({
          compaction: { ...facts().compaction, loopHalts: 1, firstTurnPrefixOver: 3 },
          fanout: { ...facts().fanout, childrenCompleted: 3 },
        }),
      },
    ]);
    expect(cell.label).toBe(ARM_LABEL.on);
    expect(cell.trials).toBe(2);
    expect(cell.successes).toBe(1);
    expect(cell.passRate).toBe(0.5);
    expect(cell.medianDurationMs).toBe(900_000);
    expect(cell.medianSteps).toBe(4);
    expect(cell.medianSessionsPerStep).toBe(0.25);
    expect(cell.reusedSessions).toBe(2);
    expect(cell.compactions).toEqual({ betweenTurn: 4, midTurn: 2, forceFit: 0, observable: true });
    expect(cell.maxContextFill).toBe(0.7);
    expect(cell.fanout).toEqual({ spawned: 10, completed: 8 });
    expect(cell.failureClasses).toEqual({ 'model/compaction-loop': 1 });
    expect(cell.bugWatch).toEqual([
      'compaction-loop',
      'fanout-incomplete',
      'prefix-over-threshold',
    ]);
  });

  it('flags an arm whose runtime resolved the other mode', () => {
    const on = summarizeCell('m', 'on', 's', [
      {
        trialId: 't',
        success: true,
        durationMs: 1,
        continuity: facts({ resolvedModes: { generalist: 0, stepwise: 1 } }),
      },
    ]);
    expect(on.bugWatch).toContain('generalist-not-resolved');
    const off = summarizeCell('m', 'off', 's', [
      { trialId: 't', success: true, durationMs: 1, continuity: facts() },
    ]);
    expect(off.bugWatch).toContain('stepwise-arm-ran-generalist');
  });

  it('renders one row per (scenario, arm) and an n/a compaction cell for CLI arms', () => {
    const cells = [
      summarizeCell('opus', 'on', 's1', [
        {
          trialId: 't',
          success: true,
          durationMs: 120_000,
          continuity: facts({ compaction: { ...facts().compaction, observable: false } }),
        },
      ]),
      summarizeCell('opus', 'off', 's1', [{ trialId: 't', success: false, durationMs: 240_000 }]),
    ];
    const md = renderMarkdown(cells, { gitSha: 'abc123' }, ['off', 'on']);
    expect(md).toContain('## opus');
    expect(md).toContain('| s1 | stepwise | 0/1 (0%) |');
    expect(md).toContain('| s1 | generalist | 1/1 (100%) | 2m |');
    expect(md).toContain('| n/a |');
    expect(md).toContain('- **gitSha:** abc123');
  });
});

describe('resolveAbRepairPolicy', () => {
  it('defaults craftbook cells to the runtime policy so the harness stays out of the A/B', () => {
    expect(resolveAbRepairPolicy({})).toBe('runtime');
  });

  it('lets a deliberate comparison with the standard matrix opt back into harness repairs', () => {
    expect(resolveAbRepairPolicy({ 'repair-policy': 'harness' })).toBe('harness');
  });
});
