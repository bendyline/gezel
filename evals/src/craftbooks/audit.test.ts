import { describe, expect, it } from 'vitest';
import {
  auditCraftbookTemplate,
  auditCraftbookTemplates,
  validateCraftbookEvalSpecs,
  validationScopeForSpec,
} from './audit.ts';
import { loadCraftbookTemplates } from './catalog.ts';
import { CRAFTBOOK_EVAL_SPECS, runnableGenericCraftbookSpecs } from './specs.ts';
import type { CraftbookEvalSpec, CraftbookTemplateSummary } from './types.ts';

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
    expect(summary.workflowSpecs + summary.artifactTaskSpecs).toBe(summary.evalSpecs);
    expect(summary.workflowSpecs).toBeGreaterThan(0);
    expect(summary.byEvalStatus.missing).toBe(summary.totalTemplates - summary.evalSpecs);
    expect(summary.artifactOnlyValidatedSpecs).toBeGreaterThan(0);
    expect(summary.workflowValidatedSpecs + summary.artifactOnlyValidatedSpecs).toBe(
      summary.validatedSpecs,
    );
  });

  it('does not let ignored spawn metadata turn a linked custom scenario into workflow proof', () => {
    const linked = CRAFTBOOK_EVAL_SPECS.find((spec) => spec.craftbookId === 'pull-request-review');
    expect(linked?.existingScenarioId).toBe('large-pr-review');
    expect(linked?.mode).toBe('artifact-task');
  });

  it('ties validation proof to the explicit eval mode', () => {
    const spec: CraftbookEvalSpec = {
      craftbookId: 'sample',
      mode: 'artifact-task',
      scenarioId: 'craftbook-sample',
      title: 'Sample',
      objective: 'Exercise a real workflow.',
      prompt: 'Run it.',
      setup: { projectName: 'Sample' },
      success: {
        summary: 'The output exists.',
        taskGraph: { requireCraftbookTask: true, requireTerminalStep: true },
      },
      coverage: { status: 'validated' },
      qualityFocus: [],
    };
    expect(validationScopeForSpec(spec)).toBe('artifact-only');
    spec.mode = 'workflow';
    expect(validationScopeForSpec(spec)).toBe('artifact-only');
    spec.coverage.validatedMode = 'workflow';
    expect(validationScopeForSpec(spec)).toBe('workflow');
  });

  it('distinguishes artifact validation from proof that the craftbook workflow ran', () => {
    const template: CraftbookTemplateSummary = {
      id: 'sample',
      name: 'Sample',
      triggers: ['sample'],
      entryStepId: 'finish',
      steps: [
        {
          id: 'finish',
          name: 'Finish',
          suggestedRole: 'developer',
          prompt:
            'Finish the workflow only after checking the requested deliverable and recording the verification evidence.',
          terminal: true,
        },
      ],
    };

    expect(auditCraftbookTemplate(template, 'validated').validationScope).toBe('artifact-only');
    expect(auditCraftbookTemplate(template, 'validated', 'workflow').validationScope).toBe(
      'workflow',
    );
  });

  it('recognizes a valid hook-driven guardrail as an alternative to deliverable gates', () => {
    const guardrail: CraftbookTemplateSummary = {
      id: 'sample-guardrail',
      name: 'Sample Guardrail',
      description: 'Blocks a dangerous tool while its task is active.',
      triggers: ['turn on guardrail'],
      entryStepId: 'active',
      hooks: [
        {
          phase: 'PreToolUse',
          matcher: '^rm$',
          script: { name: 'check-danger', scope: 'craftbook' },
        },
      ],
      scripts: { 'check-danger': 'export const meta = {}; // deterministic hook fixture' },
      steps: [
        {
          id: 'active',
          name: 'Guardrail active',
          suggestedRole: 'developer',
          prompt:
            'Work normally while this task remains active. The bundled pre-tool hook enforces the safety boundary for every matching call.',
          terminal: true,
        },
      ],
    };

    const valid = auditCraftbookTemplate(guardrail, 'implemented');
    expect(valid.band).toBe('strong');
    expect(valid.issues.map((entry) => entry.code)).not.toContain('reviewer.no-evaluate-step');

    const broken = auditCraftbookTemplate({ ...guardrail, scripts: {} }, 'implemented');
    expect(broken.issues.map((entry) => entry.code)).toContain('hook.missing-script');
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

  describe('reviewer.safe-loop', () => {
    function bookWithEvaluate(gate: Record<string, unknown> | undefined): CraftbookTemplateSummary {
      return {
        id: 'sample',
        name: 'Sample',
        version: '1.0.0',
        triggers: ['do the thing'],
        entryStepId: 'fix',
        steps: [
          { id: 'fix', name: 'Fix', suggestedRole: 'engineer', next: 'evaluate' },
          {
            id: 'evaluate',
            name: 'Evaluate',
            suggestedRole: 'reviewer',
            prompt: 'Grade it. On PASS, advance_task_step to finish.',
            next: 'finish',
            ...(gate ? { gate } : {}),
          },
          { id: 'finish', name: 'Finish', suggestedRole: 'lead', terminal: true },
        ],
      };
    }

    const codes = (t: CraftbookTemplateSummary) =>
      auditCraftbookTemplate(t, 'implemented').issues.map((i) => i.code);

    it('flags an evaluate step that falls straight through to finish', () => {
      expect(codes(bookWithEvaluate(undefined))).toContain('reviewer.safe-loop');
    });

    it('clears it when a gate script routes a rejection back to another step', () => {
      // checkFixReview emits `goto` at runtime, so the repair edge exists
      // nowhere in `next`. These books have the strongest loop in the library
      // — the runtime routes REVISE whatever the model does — and used to be
      // penalized for it.
      const gate = {
        at: 'completion',
        checks: [{ kind: 'minBytes', file: 'review.md', bytes: 400 }],
        scripts: [
          { name: 'checkFixReview', inputs: { reviewPath: 'review.md', fixStepId: 'fix' } },
        ],
        onReject: 'evaluate',
        maxAttempts: 4,
      };
      expect(codes(bookWithEvaluate(gate))).not.toContain('reviewer.safe-loop');
    });

    it('still flags when the gate script names no step in this book', () => {
      const gate = {
        at: 'completion',
        checks: [{ kind: 'minBytes', file: 'review.md', bytes: 400 }],
        scripts: [{ name: 'checkContains', inputs: { needle: 'Verdict' } }],
        onReject: 'evaluate',
        maxAttempts: 4,
      };
      expect(codes(bookWithEvaluate(gate))).toContain('reviewer.safe-loop');
    });

    it('no longer reports the bundled fix-review books as loopless', async () => {
      const templates = await loadCraftbookTemplates();
      const { audits } = auditCraftbookTemplates(templates);
      const byId = new Map(audits.map((a) => [a.craftbookId, a]));
      for (const id of ['accessibility-retrofit', 'ci-pipeline', 'hotfix-flow']) {
        expect(byId.get(id)?.issues.map((i) => i.code) ?? []).not.toContain('reviewer.safe-loop');
      }
    });
  });

  it('has at least one generic craftbook scenario available to evals', () => {
    expect(runnableGenericCraftbookSpecs().map((spec) => spec.scenarioId)).toContain(
      'craftbook-form-wizard',
    );
  });
});
