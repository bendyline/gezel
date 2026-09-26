import { describe, expect, it } from 'vitest';
import { auditCraftbookTemplates } from './audit.ts';
import { buildCraftbookBatchPlan } from './batch-plan.ts';
import { findBoilerplateEvalSpecs } from './boilerplate.ts';
import { loadCraftbookTemplates } from './catalog.ts';
import { auditDeliverableReachability } from './deliverable-reachability.ts';
import { CRAFTBOOK_EVAL_SPECS } from './specs.ts';
import type { DeliverableReachabilityFinding } from './deliverable-reachability.ts';

async function corpusPlan(
  mode?: 'workflow' | 'artifact-task',
  reachabilityFindings?: DeliverableReachabilityFinding[],
) {
  const templates = await loadCraftbookTemplates();
  const { audits } = auditCraftbookTemplates(templates);
  return buildCraftbookBatchPlan({
    templates,
    audits,
    target: 50,
    ...(mode ? { mode } : {}),
    specs: CRAFTBOOK_EVAL_SPECS,
    reachabilityFindings:
      reachabilityFindings ??
      auditDeliverableReachability(CRAFTBOOK_EVAL_SPECS, templates).findings,
    boilerplateFindings: findBoilerplateEvalSpecs(CRAFTBOOK_EVAL_SPECS),
  });
}

describe('craftbook batch plan', () => {
  it('selects a 50-craftbook plan with simulator and fixture classes', async () => {
    const plan = await corpusPlan();

    expect(plan.items).toHaveLength(50);
    expect(plan.runnableNow.some((item) => item.craftbookId === 'form-wizard')).toBe(true);
    expect(plan.runnableNow.some((item) => item.craftbookId === 'pull-request-review')).toBe(true);
    expect(plan.harnessCounts['seeded-corpus']).toBeGreaterThan(0);
    expect(plan.harnessCounts['html-playwright']).toBeGreaterThan(0);
    expect(plan.harnessCounts['hook-runtime']).toBeGreaterThan(0);
    expect(plan.items.some((item) => item.simulatorIds.length > 0)).toBe(true);
  });

  it('can produce a workflow-only matrix plan', async () => {
    const plan = await corpusPlan('workflow');

    expect(plan.mode).toBe('workflow');
    expect(plan.items.length).toBeGreaterThan(0);
    expect(plan.items.length).toBeLessThanOrEqual(50);
    expect(plan.items.every((item) => item.evalMode === 'workflow')).toBe(true);
    expect(plan.runnableNow.every((item) => item.mode === 'workflow')).toBe(true);
  });

  it('excludes inverted and boilerplate evals while accepting symbolic output paths', async () => {
    const plan = await corpusPlan();
    const runnable = new Set(plan.runnableNow.map((item) => item.craftbookId));
    const excluded = new Map(plan.excluded.map((item) => [item.craftbookId, item.reasons]));

    expect(runnable.has('db-index-tuning')).toBe(false);
    expect(excluded.get('db-index-tuning')?.some((reason) => reason.code === 'unreachable')).toBe(
      true,
    );
    expect(runnable.has('email-template')).toBe(false);
    expect(excluded.get('email-template')?.some((reason) => reason.code === 'unreachable')).toBe(
      true,
    );
    expect(runnable.has('character-sheet')).toBe(true);
    expect(runnable.has('audio-ad-spot')).toBe(false);
    expect(excluded.get('audio-ad-spot')?.some((reason) => reason.code === 'boilerplate')).toBe(true);
    expect(plan.scenarioCsv.split(',')).toEqual(plan.runnableNow.map((item) => item.scenarioId));
  });

  it('keeps a detected folder drift in the repair backlog', async () => {
    const plan = await corpusPlan(undefined, [
      {
        craftbookId: 'character-sheet',
        scenarioId: 'craftbook-character-sheet',
        verdict: 'folder-drift',
        paths: ['wrong/sheet.json'],
        bookGatedPaths: ['characters/<name>/sheet.json'],
      },
    ]);
    expect(plan.runnableNow.some((item) => item.craftbookId === 'character-sheet')).toBe(false);
    expect(
      plan.excluded
        .find((item) => item.craftbookId === 'character-sheet')
        ?.reasons.some((reason) => reason.code === 'folder-drift'),
    ).toBe(true);
  });

  it('puts unproven workflow evals ahead of artifact-only work', async () => {
    const plan = await corpusPlan();
    const firstArtifact = plan.items.findIndex((item) => item.evalMode === 'artifact-task');
    const lastUnprovenWorkflow = plan.items.reduce(
      (last, item, index) =>
        item.evalMode === 'workflow' && item.validationScope !== 'workflow' ? index : last,
      -1,
    );
    expect(firstArtifact).toBeGreaterThanOrEqual(0);
    expect(lastUnprovenWorkflow).toBeGreaterThanOrEqual(0);
    expect(lastUnprovenWorkflow).toBeLessThan(firstArtifact);
  });
});
