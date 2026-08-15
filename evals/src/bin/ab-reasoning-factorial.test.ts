import { describe, expect, it } from 'vitest';
import {
  buildReasoningFactorialPlan,
  parseReasoningLaunchDiagnostic,
  reasoningLaunchMatchesArm,
} from './ab-reasoning-factorial.ts';

describe('reasoning factorial plan', () => {
  it('builds 36 counterbalanced cells for the default 3x3x4 design', () => {
    const scenarios = ['self-correction-broken-js', 'incident-postmortem', 'schema-migration'];
    const plan = buildReasoningFactorialPlan({ scenarioIds: scenarios, count: 3 });
    expect(plan).toHaveLength(36);
    for (let replicate = 1; replicate <= 3; replicate++) {
      for (const scenarioId of scenarios) {
        const cellArms = plan
          .filter((cell) => cell.replicate === replicate && cell.scenarioId === scenarioId)
          .map((cell) => cell.arm.id);
        expect(new Set(cellArms).size).toBe(4);
      }
    }
    expect(plan.slice(0, 4).map((cell) => cell.arm.id)).toEqual([
      'preserve-off-budget-4096',
      'preserve-on-budget-4096',
      'preserve-on-budget-8192',
      'preserve-off-budget-8192',
    ]);
    expect(plan[12]?.scenarioId).toBe('incident-postmortem');
  });

  it('rejects empty or invalid experiment plans', () => {
    expect(() => buildReasoningFactorialPlan({ scenarioIds: [], count: 3 })).toThrow(
      /at least one scenario/,
    );
    expect(() => buildReasoningFactorialPlan({ scenarioIds: ['x'], count: 0 })).toThrow(
      /positive integer/,
    );
  });
});

describe('reasoning launch provenance', () => {
  it('reads the latest structured launch record', () => {
    const diagnostic = parseReasoningLaunchDiagnostic(
      [
        '[llama-server] launch {"reasoningBudgetTokens":8192,"reasoningBudgetSource":"catalog","reasoningPreserve":false}',
        '[noise] unrelated',
        '[llama-server] launch {"reasoningBudgetTokens":4096,"reasoningBudgetSource":"env","reasoningPreserve":true}',
      ].join('\n'),
    );
    expect(diagnostic).toEqual({
      reasoningBudgetTokens: 4096,
      reasoningBudgetSource: 'env',
      reasoningPreserve: true,
    });
    expect(
      reasoningLaunchMatchesArm(diagnostic, {
        id: 'on-4096',
        preserve: true,
        budgetTokens: 4096,
      }),
    ).toBe(true);
  });

  it('rejects a collapsed or missing arm', () => {
    const arm = { id: 'off-4096', preserve: false, budgetTokens: 4096 as const };
    expect(reasoningLaunchMatchesArm(null, arm)).toBe(false);
    expect(
      reasoningLaunchMatchesArm({ reasoningBudgetTokens: 8192, reasoningPreserve: false }, arm),
    ).toBe(false);
  });
});
