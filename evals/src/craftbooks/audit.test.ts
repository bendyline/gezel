import { describe, expect, it } from 'vitest';
import {
  auditCraftbookTemplate,
  auditCraftbookTemplates,
  validateCraftbookEvalSpecs,
} from './audit.ts';
import { loadCraftbookTemplates } from './catalog.ts';
import { CRAFTBOOK_EVAL_SPECS, runnableGenericCraftbookSpecs } from './specs.ts';
import type { CraftbookTemplateSummary } from './types.ts';

describe('craftbook eval audit', () => {
  it('keeps eval specs pointed at real bundled craftbooks', async () => {
    const templates = await loadCraftbookTemplates();
    const errors = validateCraftbookEvalSpecs(templates);
    expect(errors).toEqual([]);
  });

  it('audits the bundled craftbook catalog without requiring full eval coverage yet', async () => {
    const templates = await loadCraftbookTemplates();
    const { audits, summary } = auditCraftbookTemplates(templates);
    expect(audits).toHaveLength(templates.length);
    expect(summary.totalTemplates).toBeGreaterThan(100);
    expect(summary.evalSpecs).toBe(CRAFTBOOK_EVAL_SPECS.length);
    expect(summary.byEvalStatus.missing).toBe(summary.totalTemplates - summary.evalSpecs);
  });

  it('scores a well-structured craftbook above a weak one', () => {
    const strong: CraftbookTemplateSummary = {
      id: 'sample-strong',
      name: 'Sample Strong',
      description: 'Strong sample',
      version: '1.0.0',
      triggers: ['sample strong'],
      entryStepId: 'build',
      steps: [
        {
          id: 'build',
          name: 'Build',
          suggestedRole: 'developer',
          prompt:
            'Build workspace/index.html with real HTML, CSS, and JavaScript. Write the file and note the acceptance criteria that now pass.',
          advanceWhen: { file: 'index.html', minBytes: 1, sniff: 'html-complete' },
          gate: {
            at: 'completion',
            checks: [{ kind: 'minBytes', file: 'index.html', bytes: 800 }],
            onReject: 'build',
            maxAttempts: 4,
          },
          next: 'evaluate',
        },
        {
          id: 'evaluate',
          name: 'Evaluate',
          suggestedRole: 'reviewer',
          prompt:
            'Review the deliverable. If every criterion passes, call advance_task_step with next finish. If any criterion fails, call advance_task_step back to build with the gaps.',
          next: 'build',
        },
        {
          id: 'finish',
          name: 'Finish',
          suggestedRole: 'developer',
          prompt:
            'Write a DONE summary with the deliverable path and the criteria that passed, then report DONE.',
          terminal: true,
        },
      ],
    };
    const weak: CraftbookTemplateSummary = {
      id: 'sample-weak',
      name: 'Sample Weak',
      version: '1.0.0',
      triggers: [],
      entryStepId: 'start',
      steps: [{ id: 'start', name: 'Start' }],
    };

    expect(auditCraftbookTemplate(strong, 'implemented').score).toBeGreaterThan(
      auditCraftbookTemplate(weak, 'missing').score,
    );
  });

  it('has at least one generic craftbook scenario available to evals', () => {
    expect(runnableGenericCraftbookSpecs().map((spec) => spec.scenarioId)).toContain(
      'craftbook-form-wizard',
    );
  });
});
