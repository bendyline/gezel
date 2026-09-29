import { EvalCatalogSchema } from '@bendyline/gezel/eval';
import { describe, expect, it } from 'vitest';
import { buildEvalCatalog } from './eval-catalog.ts';
import { listSuites } from './suites.ts';

describe('buildEvalCatalog', () => {
  const catalog = buildEvalCatalog();
  const byId = new Map(catalog.scenarios.map((scenario) => [scenario.id, scenario]));

  it('matches the schema the daemon parses it with', () => {
    expect(EvalCatalogSchema.safeParse(catalog).success).toBe(true);
  });

  it('lists every suite with members that resolve', () => {
    expect(catalog.suites.map((suite) => suite.id)).toEqual(listSuites().map((suite) => suite.id));
    for (const suite of catalog.suites) {
      for (const id of suite.scenarioIds) expect(byId.has(id), `${suite.id}/${id}`).toBe(true);
      expect(suite.authoredCeilingMs).toBeGreaterThan(0);
    }
    expect(catalog.defaultSuiteId).toBe('core');
  });

  it('marks the frozen anchors and records suite membership', () => {
    expect(byId.get('tictactoe')).toMatchObject({ anchored: true, kind: 'scenario' });
    expect(byId.get('tictactoe')?.suites).toContain('core');
    expect(byId.get('schema-migration')?.anchored).toBe(false);
  });

  it('derives requirements from scenario fields and declarations', () => {
    expect(byId.get('petshop')?.requires).toEqual(['chromium', 'image-model']);
    expect(byId.get('failing-tests-spec')?.requires).toEqual(['vitest']);
    expect(byId.get('squisq-review')?.requires).toEqual(['network']);
  });

  it('separates generated craftbook scenarios from hand-authored ones', () => {
    const kinds = new Set(catalog.scenarios.map((scenario) => scenario.kind));
    expect(kinds).toEqual(new Set(['scenario', 'craftbook', 'craftbook-authoring']));
    for (const scenario of catalog.scenarios) {
      if (scenario.kind === 'craftbook') expect(scenario.id.startsWith('craftbook-')).toBe(true);
    }
  });

  it('names a default model for every provider', () => {
    for (const provider of catalog.providers)
      expect(provider.defaultModelId.length).toBeGreaterThan(0);
  });
});
