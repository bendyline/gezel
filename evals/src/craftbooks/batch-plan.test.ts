import { describe, expect, it } from 'vitest';
import { auditCraftbookTemplates } from './audit.ts';
import { buildCraftbookBatchPlan } from './batch-plan.ts';
import { loadCraftbookTemplates } from './catalog.ts';

describe('craftbook batch plan', () => {
  it('selects a 50-craftbook plan with simulator and fixture classes', async () => {
    const templates = await loadCraftbookTemplates();
    const { audits } = auditCraftbookTemplates(templates);
    const plan = buildCraftbookBatchPlan({ templates, audits, target: 50 });

    expect(plan.items).toHaveLength(50);
    expect(plan.runnableNow).toContain('form-wizard');
    expect(plan.runnableNow).toContain('reviewer-loop');
    expect(plan.harnessCounts['seeded-corpus']).toBeGreaterThan(0);
    expect(plan.harnessCounts['html-playwright']).toBeGreaterThan(0);
    expect(plan.harnessCounts['hook-runtime']).toBeGreaterThan(0);
    expect(plan.items.some((item) => item.simulatorIds.length > 0)).toBe(true);
  });

  it('can produce a workflow-only matrix plan', async () => {
    const templates = await loadCraftbookTemplates();
    const { audits } = auditCraftbookTemplates(templates);
    const plan = buildCraftbookBatchPlan({ templates, audits, target: 50, mode: 'workflow' });

    expect(plan.mode).toBe('workflow');
    expect(plan.items.length).toBeGreaterThan(0);
    expect(plan.items.length).toBeLessThanOrEqual(50);
    expect(plan.items.every((item) => item.evalMode === 'workflow')).toBe(true);
    expect(plan.runnableNow).toEqual(
      expect.arrayContaining(plan.items.map((item) => item.craftbookId)),
    );
  });
});
