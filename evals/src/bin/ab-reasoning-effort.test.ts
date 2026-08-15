import { describe, expect, it } from 'vitest';
import {
  buildReasoningEffortPlan,
  parseReasoningRequestDiagnostics,
  reasoningEffortConfigurationMatches,
} from './ab-reasoning-effort.ts';

describe('reasoning effort A/B plan', () => {
  it('builds 18 counterbalanced cells for the default 3x3x2 design', () => {
    const scenarios = ['incident-postmortem', 'schema-migration', 'tool-routing-retrieval'];
    const plan = buildReasoningEffortPlan({ scenarioIds: scenarios, count: 3 });
    expect(plan).toHaveLength(18);
    for (let replicate = 1; replicate <= 3; replicate++) {
      for (const scenarioId of scenarios) {
        expect(
          plan
            .filter((cell) => cell.replicate === replicate && cell.scenarioId === scenarioId)
            .map((cell) => cell.effort)
            .sort(),
        ).toEqual(['medium', 'xhigh']);
      }
    }
    expect(plan.slice(0, 2).map((cell) => cell.effort)).toEqual(['xhigh', 'medium']);
    expect(plan[6]?.scenarioId).toBe('schema-migration');
  });

  it('rejects empty and invalid plans', () => {
    expect(() => buildReasoningEffortPlan({ scenarioIds: [], count: 3 })).toThrow(/one scenario/);
    expect(() => buildReasoningEffortPlan({ scenarioIds: ['x'], count: 0 })).toThrow(
      /positive integer/,
    );
  });
});

describe('reasoning effort request provenance', () => {
  it('parses structured request diagnostics and validates the fixed controls', () => {
    const requests = parseReasoningRequestDiagnostics(
      [
        '[debug] [llama-cpp] request-reasoning {"model":"qwen","iteration":0,"enableThinking":true,"reasoningEffort":"xhigh"}',
        '[debug] [llama-cpp] request-reasoning {"model":"qwen","iteration":1,"enableThinking":false,"reasoningEffort":"low"}',
      ].join('\n'),
    );
    expect(requests).toHaveLength(2);
    expect(
      reasoningEffortConfigurationMatches({
        launch: { reasoningBudgetTokens: 4096, reasoningPreserve: false },
        requests,
        effort: 'xhigh',
      }),
    ).toBe(true);
  });

  it('rejects collapsed, missing, or wrong-launch arms', () => {
    const medium = [{ enableThinking: true, reasoningEffort: 'medium' }];
    expect(
      reasoningEffortConfigurationMatches({
        launch: { reasoningBudgetTokens: 4096, reasoningPreserve: false },
        requests: medium,
        effort: 'xhigh',
      }),
    ).toBe(false);
    expect(
      reasoningEffortConfigurationMatches({
        launch: { reasoningBudgetTokens: 8192, reasoningPreserve: false },
        requests: medium,
        effort: 'medium',
      }),
    ).toBe(false);
    expect(
      reasoningEffortConfigurationMatches({
        launch: { reasoningBudgetTokens: 4096, reasoningPreserve: false },
        requests: [],
        effort: 'medium',
      }),
    ).toBe(false);
    expect(
      reasoningEffortConfigurationMatches({
        launch: { reasoningBudgetTokens: 4096, reasoningPreserve: false },
        requests: [
          { enableThinking: true, reasoningEffort: 'medium' },
          { enableThinking: true, reasoningEffort: 'high' },
        ],
        effort: 'medium',
      }),
    ).toBe(false);
  });
});
