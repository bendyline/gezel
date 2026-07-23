import { type StepGateUnion, StepGateUnionSchema, normalizeStepGate } from '@bendyline/gezel';
import { CRAFTBOOK_EVAL_SPECS, craftbookEvalSpecMap } from './specs.ts';
import type {
  CraftbookAuditIssue,
  CraftbookAuditResult,
  CraftbookCoverageSummary,
  CraftbookEvalCoverageStatus,
  CraftbookTemplateStepSummary,
  CraftbookTemplateSummary,
} from './types.ts';

function issue(
  severity: CraftbookAuditIssue['severity'],
  code: string,
  message: string,
  stepId?: string,
): CraftbookAuditIssue {
  return { severity, code, message, ...(stepId ? { stepId } : {}) };
}

function parseGate(step: CraftbookTemplateStepSummary): StepGateUnion | null {
  if (!step.gate) return null;
  const parsed = StepGateUnionSchema.safeParse(step.gate);
  return parsed.success ? parsed.data : null;
}

function nonTerminalSteps(template: CraftbookTemplateSummary): CraftbookTemplateStepSummary[] {
  return template.steps.filter((step) => !step.terminal);
}

function hasSubstantivePrompt(step: CraftbookTemplateStepSummary): boolean {
  return (step.prompt ?? '').trim().length >= 80;
}

function stepHasForwardEdge(step: CraftbookTemplateStepSummary): boolean {
  return !!step.next || !!step.terminal;
}

function evaluateStep(
  template: CraftbookTemplateSummary,
): CraftbookTemplateStepSummary | undefined {
  return template.steps.find((step) => step.id === 'evaluate');
}

export function auditCraftbookTemplate(
  template: CraftbookTemplateSummary,
  evalStatus: CraftbookEvalCoverageStatus = 'missing',
): CraftbookAuditResult {
  const issues: CraftbookAuditIssue[] = [];
  const steps = template.steps;
  const nonTerminal = nonTerminalSteps(template);
  const terminalSteps = steps.filter((step) => step.terminal);
  const gates = steps
    .map((step) => ({ step, gate: parseGate(step) }))
    .filter((entry) => entry.gate);
  const malformedGateSteps = steps.filter((step) => step.gate && !parseGate(step));
  const advanceWhenSteps = steps.filter((step) => !!step.advanceWhen);

  if (evalStatus === 'missing') {
    issues.push(
      issue(
        'warn',
        'eval.missing',
        'No craftbook eval spec exists yet; add one before calling this template measured.',
      ),
    );
  }
  if (terminalSteps.length === 0) {
    issues.push(issue('fail', 'graph.no-terminal', 'No terminal step found.'));
  }
  if (!steps.some((step) => step.id === template.entryStepId)) {
    issues.push(
      issue('fail', 'graph.bad-entry', `entryStepId "${template.entryStepId}" is not a step id.`),
    );
  }
  for (const step of nonTerminal.filter((s) => !stepHasForwardEdge(s))) {
    issues.push(
      issue('warn', 'graph.no-edge', 'Non-terminal step has no explicit next edge.', step.id),
    );
  }
  for (const step of nonTerminal.filter((s) => !s.suggestedRole)) {
    issues.push(issue('warn', 'role.missing', 'Non-terminal step has no suggestedRole.', step.id));
  }
  for (const step of steps.filter((s) => !hasSubstantivePrompt(s))) {
    issues.push(
      issue(
        'warn',
        'prompt.short',
        'Step prompt is missing or too short to carry a local model.',
        step.id,
      ),
    );
  }
  for (const step of malformedGateSteps) {
    issues.push(
      issue('fail', 'gate.malformed', 'Step gate does not parse as a known gate shape.', step.id),
    );
  }
  for (const step of advanceWhenSteps.filter((s) => !s.gate)) {
    issues.push(
      issue(
        'warn',
        'gate.advance-without-gate',
        'Step auto-advances on a deliverable but has no completion gate.',
        step.id,
      ),
    );
  }
  for (const { step, gate } of gates) {
    if (!gate) continue;
    const normalized = normalizeStepGate(gate);
    if (normalized.checks.length === 0 && normalized.scripts.length === 0) {
      issues.push(issue('fail', 'gate.empty', 'Gate has neither checks nor scripts.', step.id));
    }
    if (normalized.at === 'completion' && !normalized.onReject) {
      issues.push(
        issue(
          'warn',
          'gate.no-reject-route',
          'Completion gate has no onReject repair route.',
          step.id,
        ),
      );
    }
    if (normalized.maxAttempts > 6) {
      issues.push(
        issue(
          'warn',
          'gate.too-many-attempts',
          'Gate allows more than six attempts before pausing.',
          step.id,
        ),
      );
    }
  }

  const evaluator = evaluateStep(template);
  if (!evaluator) {
    issues.push(
      issue(
        'info',
        'reviewer.no-evaluate-step',
        'No evaluate step found; confirm another gate or branch does the final judgment.',
      ),
    );
  } else {
    const prompt = evaluator.prompt ?? '';
    if (!/review|qa|verify|evaluate/i.test(evaluator.suggestedRole ?? '')) {
      issues.push(
        issue(
          'warn',
          'reviewer.role',
          'Evaluate step is not routed to an obvious reviewer/QA role.',
          evaluator.id,
        ),
      );
    }
    if (evaluator.next === 'finish') {
      issues.push(
        issue(
          'warn',
          'reviewer.safe-loop',
          'Evaluate step defaults directly to finish instead of a repair loop.',
          evaluator.id,
        ),
      );
    }
    if (!/advance_task_step/.test(prompt) || !/finish/.test(prompt)) {
      issues.push(
        issue(
          'warn',
          'reviewer.routing-prompt',
          'Evaluate prompt does not explicitly teach pass/fail routing.',
          evaluator.id,
        ),
      );
    }
  }
  if ((template.triggers ?? []).length === 0) {
    issues.push(issue('info', 'invoke.no-triggers', 'No natural-language triggers declared.'));
  }

  const structureScore =
    (steps.length >= 2 ? 5 : 0) +
    (terminalSteps.length > 0 ? 5 : 0) +
    (steps.some((step) => step.id === template.entryStepId) ? 5 : 0) +
    (nonTerminal.length > 0 && nonTerminal.every(stepHasForwardEdge) ? 5 : 0);
  const roleScore =
    nonTerminal.length === 0
      ? 15
      : Math.round(
          (nonTerminal.filter((step) => !!step.suggestedRole).length / nonTerminal.length) * 15,
        );
  const promptScore =
    steps.length === 0
      ? 0
      : Math.round((steps.filter(hasSubstantivePrompt).length / steps.length) * 15);
  const gateScore =
    gates.length === 0
      ? 0
      : Math.round(
          (gates.filter((entry) => entry.gate !== null).length / gates.length) * 5 +
            (gates.filter((entry) => {
              if (!entry.gate) return false;
              const normalized = normalizeStepGate(entry.gate);
              return normalized.checks.length + normalized.scripts.length > 0;
            }).length /
              gates.length) *
              8 +
            (advanceWhenSteps.length === 0
              ? 5
              : (advanceWhenSteps.filter((step) => !!step.gate).length / advanceWhenSteps.length) *
                5) +
            (gates.filter((entry) => {
              if (!entry.gate) return false;
              const normalized = normalizeStepGate(entry.gate);
              return normalized.at !== 'completion' || !!normalized.onReject;
            }).length /
              gates.length) *
              7,
        );
  const reviewerScore = evaluator
    ? (/(review|qa|verify|evaluate)/i.test(evaluator.suggestedRole ?? '') ? 4 : 0) +
      (evaluator.next && evaluator.next !== 'finish' ? 4 : 0) +
      (/advance_task_step/.test(evaluator.prompt ?? '') ? 4 : 0) +
      (/finish/.test(evaluator.prompt ?? '') ? 3 : 0)
    : 3;
  const invocabilityScore =
    (template.description ? 3 : 0) + ((template.triggers ?? []).length > 0 ? 4 : 0) + 3;
  const evalScore =
    evalStatus === 'validated'
      ? 10
      : evalStatus === 'implemented'
        ? 7
        : evalStatus === 'planned'
          ? 3
          : 0;

  const score =
    structureScore +
    roleScore +
    promptScore +
    gateScore +
    reviewerScore +
    invocabilityScore +
    evalScore;
  const band: CraftbookAuditResult['band'] =
    score >= 80 ? 'strong' : score >= 60 ? 'needs-work' : 'weak';

  return {
    craftbookId: template.id,
    name: template.name,
    score,
    maxScore: 110,
    band,
    hasEvalSpec: evalStatus !== 'missing',
    evalStatus,
    issues,
  };
}

export function summarizeCraftbookAudits(audits: CraftbookAuditResult[]): CraftbookCoverageSummary {
  const byBand: CraftbookCoverageSummary['byBand'] = {
    strong: 0,
    'needs-work': 0,
    weak: 0,
  };
  const byEvalStatus: CraftbookCoverageSummary['byEvalStatus'] = {
    missing: 0,
    planned: 0,
    implemented: 0,
    validated: 0,
  };
  for (const audit of audits) {
    byBand[audit.band]++;
    byEvalStatus[audit.evalStatus]++;
  }
  const totalScore = audits.reduce((sum, audit) => sum + audit.score, 0);
  return {
    totalTemplates: audits.length,
    evalSpecs: audits.filter((audit) => audit.hasEvalSpec).length,
    implementedSpecs: audits.filter((audit) => audit.evalStatus === 'implemented').length,
    validatedSpecs: audits.filter((audit) => audit.evalStatus === 'validated').length,
    averageQualityScore: audits.length === 0 ? 0 : Number((totalScore / audits.length).toFixed(1)),
    byBand,
    byEvalStatus,
  };
}

export function auditCraftbookTemplates(templates: CraftbookTemplateSummary[]): {
  audits: CraftbookAuditResult[];
  summary: CraftbookCoverageSummary;
} {
  const specMap = craftbookEvalSpecMap();
  const audits = templates.map((template) => {
    const status = specMap.get(template.id)?.coverage.status ?? 'missing';
    return auditCraftbookTemplate(template, status);
  });
  return { audits, summary: summarizeCraftbookAudits(audits) };
}

export function validateCraftbookEvalSpecs(templates: CraftbookTemplateSummary[]): string[] {
  const ids = new Set(templates.map((template) => template.id));
  const scenarioIds = new Set<string>();
  const errors: string[] = [];
  for (const spec of CRAFTBOOK_EVAL_SPECS) {
    if (!ids.has(spec.craftbookId)) {
      errors.push(`eval spec references unknown craftbook "${spec.craftbookId}"`);
    }
    if (scenarioIds.has(spec.scenarioId)) {
      errors.push(`duplicate craftbook eval scenario id "${spec.scenarioId}"`);
    }
    scenarioIds.add(spec.scenarioId);
    if (spec.coverage.status !== 'planned' && !spec.existingScenarioId && !spec.prompt) {
      errors.push(`implemented generic spec "${spec.scenarioId}" needs a prompt`);
    }
  }
  return errors;
}
