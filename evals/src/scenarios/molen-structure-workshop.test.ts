import { describe, expect, it } from 'vitest';
import {
  assertWorkshopOutputs,
  molenFootballStadiumScenario,
  molenSpaceNeedleScenario,
  selectWorkshopRequests,
} from './molen-structure-workshop.ts';

describe('standalone Molen workshop inputs and output gates', () => {
  const school = { id: 'brick-school', brief: 'original school request' };
  const needle = { id: 'space-needle', brief: 'original landmark request' };

  it('gives the landmark its own unchanged request without spending its budget on school', () => {
    const source = { requests: [school, needle] };
    expect(selectWorkshopRequests(source, ['space-needle'])).toEqual({ requests: [needle] });
    expect(source.requests).toEqual([school, needle]);
  });

  it('fails setup for absent or ambiguous frozen requests', () => {
    expect(() => selectWorkshopRequests({ requests: [school] }, ['space-needle'])).toThrow();
    expect(() =>
      selectWorkshopRequests({ requests: [needle, needle] }, ['space-needle']),
    ).toThrow();
    expect(() => selectWorkshopRequests({ requests: [needle] }, [])).toThrow();
    expect(() =>
      selectWorkshopRequests({ requests: [needle] }, ['space-needle', 'space-needle']),
    ).toThrow();
  });

  it('rejects a reduced, substituted or duplicated deliverable set', () => {
    expect(() => assertWorkshopOutputs(['space-needle'], [needle])).not.toThrow();
    expect(() => assertWorkshopOutputs(['brick-school', 'space-needle'], [needle])).toThrow();
    expect(() => assertWorkshopOutputs(['space-needle'], [school])).toThrow();
    expect(() => assertWorkshopOutputs(['space-needle'], [needle, needle])).toThrow();
  });

  it('registers distinct prompt cases with real setup and final validation', () => {
    for (const [scenario, id] of [
      [molenSpaceNeedleScenario, 'molen-structure-space-needle'],
      [molenFootballStadiumScenario, 'molen-structure-football-stadium'],
    ] as const) {
      expect(scenario.id).toBe(id);
      expect(scenario.skipInitialPrompt).toBe(true);
      expect(scenario.setup).toBeTypeOf('function');
      expect(scenario.successCheck).toBeTypeOf('function');
    }
  });
});
