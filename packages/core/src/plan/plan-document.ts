import { normalizeStepGate } from '../schemas/gate.js';
import type { GateCheck, NormalizedStepGate } from '../schemas/gate.js';
import type { Outcome, Task, TaskCraftbookStep } from '../schemas/task.js';

/**
 * ─ Plan document ─────────────────────────────────────────────────────
 *
 * A "plan" in gezel is a draft task whose embedded craftbook IS the plan:
 * an about, a set of outcomes, build steps each gated on a concrete static
 * deliverable, and a terminal verification step. This module renders that
 * task into a human-readable markdown document (for the chat plan card and
 * the preview pane) and summarizes it for the readiness guardrails shown
 * before a draft is activated.
 *
 * Pure and dependency-free so the chat UI, the preview pane, and the
 * service activation guard all share one source of truth.
 */

/** A terminal step that verifies outcomes — what closes a planned task. */
const VERIFICATION_RE = /outcome|verify_outcome|set_task_status/i;

export interface PlanStepSummary {
  id: string;
  name: string;
  description?: string;
  /** The concrete static deliverable this step produces, if any. */
  deliverable?: string;
  /** A short description of how the deliverable is enforced. */
  enforcement?: string;
  /** True when the step has a gate (checks/scripts) or an advanceWhen file. */
  gated: boolean;
  terminal: boolean;
  /** True when this is the terminal step that verifies outcomes. */
  isVerification: boolean;
  /** Resolved gezel or suggested role label. */
  assignee?: string;
}

export interface PlanSummary {
  title: string;
  about: string;
  outcomes: Outcome[];
  steps: PlanStepSummary[];
  buildStepCount: number;
  gatedBuildStepCount: number;
  hasVerification: boolean;
}

function describeChecks(checks: GateCheck[]): string {
  const parts: string[] = [];
  for (const c of checks) {
    switch (c.kind) {
      case 'minBytes':
        parts.push(`≥${c.bytes} bytes`);
        break;
      case 'totalMinBytes':
        parts.push(`≥${c.bytes} bytes total`);
        break;
      case 'cssMinBytes':
        parts.push(`≥${c.bytes} bytes CSS`);
        break;
      case 'fileCount':
        parts.push(`≥${c.min} files`);
        break;
      case 'sniff':
        parts.push(`${c.sniff}`);
        break;
      case 'csvShape':
        parts.push('CSV shape');
        break;
      case 'contains':
        parts.push('content match');
        break;
      case 'notContains':
        parts.push('forbidden content absent');
        break;
      default:
        parts.push('check');
    }
  }
  return parts.join(', ');
}

function deliverableOf(step: TaskCraftbookStep): { file?: string; gate?: NormalizedStepGate } {
  const gate = step.gate ? normalizeStepGate(step.gate) : undefined;
  if (step.advanceWhen?.file) return { file: step.advanceWhen.file, gate };
  const fileCheck = gate?.checks.find(
    (c): c is Extract<GateCheck, { file: string }> => 'file' in c && typeof c.file === 'string',
  );
  if (fileCheck) return { file: fileCheck.file, gate };
  const dirCheck = gate?.checks.find((c) => c.kind === 'fileCount' && !!c.dir);
  if (dirCheck && dirCheck.kind === 'fileCount' && dirCheck.dir) {
    return { file: dirCheck.dir, gate };
  }
  return { gate };
}

function stepAssigneeLabel(step: TaskCraftbookStep): string | undefined {
  if (step.assignee?.kind === 'gezel') return step.assignee.gezelId;
  if (step.suggestedGezelId) return step.suggestedGezelId;
  if (step.suggestedRole) return step.suggestedRole;
  return undefined;
}

/** Curate a draft task's craftbook + outcomes into a structured summary. */
export function summarizePlanDocument(task: Task): PlanSummary {
  const steps: PlanStepSummary[] = task.craftbook.steps.map((s) => {
    const { file, gate } = deliverableOf(s);
    const hasGate = !!gate && (gate.checks.length > 0 || gate.scripts.length > 0);
    const gated = hasGate || !!s.advanceWhen?.file;
    const isVerification = !!s.terminal && VERIFICATION_RE.test(s.prompt ?? '');
    const enforcementParts: string[] = [];
    if (gate && gate.checks.length > 0) enforcementParts.push(describeChecks(gate.checks));
    if (gate && gate.scripts.length > 0)
      enforcementParts.push(`${gate.scripts.length} script${gate.scripts.length === 1 ? '' : 's'}`);
    return {
      id: s.id,
      name: s.name,
      ...(s.description ? { description: s.description } : {}),
      ...(file ? { deliverable: file } : {}),
      ...(enforcementParts.length > 0 ? { enforcement: enforcementParts.join(', ') } : {}),
      gated,
      terminal: !!s.terminal,
      isVerification,
      ...(stepAssigneeLabel(s) ? { assignee: stepAssigneeLabel(s) } : {}),
    };
  });
  const buildSteps = steps.filter((s) => !s.terminal);
  return {
    title: task.title,
    about: (task.description ?? '').trim(),
    outcomes: task.outcomes ?? [],
    steps,
    buildStepCount: buildSteps.length,
    gatedBuildStepCount: buildSteps.filter((s) => s.gated).length,
    hasVerification: steps.some((s) => s.isVerification),
  };
}

/**
 * Readiness warnings for a plan, in human-readable form. Empty means the
 * plan is well-formed. Surfaced in the UI (with an "Approve anyway"
 * override) and enforced by `TaskManager.activate` (unless forced).
 */
export function planGuardrails(summary: PlanSummary): string[] {
  const out: string[] = [];
  if (summary.about.length < 120) out.push('the plan has only a thin "about" — flesh out the goal');
  if (summary.outcomes.length < 3) out.push('fewer than 3 outcomes are defined');
  if (summary.buildStepCount === 0) out.push('the plan has no build steps');
  else if (summary.gatedBuildStepCount < summary.buildStepCount) {
    const bare = summary.steps
      .filter((s) => !s.terminal && !s.gated)
      .map((s) => s.name)
      .join(', ');
    out.push(`some steps have no concrete deliverable + gate: ${bare}`);
  }
  if (!summary.hasVerification) out.push('there is no final verification step');
  return out;
}

/** Render a draft task as a readable markdown "plan document". */
export function renderPlanDocument(task: Task): string {
  const s = summarizePlanDocument(task);
  const lines: string[] = [];
  lines.push(`# Plan: ${s.title}`, '');
  if (s.about) lines.push(s.about, '');

  lines.push('## Outcomes', '');
  if (s.outcomes.length === 0) {
    lines.push('_No outcomes defined yet._', '');
  } else {
    for (const o of s.outcomes) {
      const box = o.met ? '[x]' : '[ ]';
      const evidence = o.met && o.evidence ? ` — _verified: ${o.evidence}_` : '';
      lines.push(`- ${box} ${o.text}${evidence}`);
    }
    lines.push('');
  }

  lines.push('## Plan steps', '');
  if (s.steps.length === 0) {
    lines.push('_No steps yet._', '');
  } else {
    s.steps.forEach((step, i) => {
      const role = step.assignee ? ` · _${step.assignee}_` : '';
      const tag = step.isVerification ? ' · _verification_' : '';
      lines.push(`${i + 1}. **${step.name}**${role}${tag}`);
      if (step.description) lines.push(`   ${step.description}`);
      if (step.deliverable) {
        const enf = step.enforcement ? ` (${step.enforcement})` : '';
        lines.push(`   → Deliverable: \`${step.deliverable}\`${enf}`);
      } else if (!step.terminal) {
        lines.push('   → ⚠️ no concrete deliverable or gate');
      }
    });
    lines.push('');
  }

  const guards = planGuardrails(s);
  lines.push('---', '');
  lines.push(guards.length === 0 ? '✅ Ready to run.' : `⚠️ Before running: ${guards.join('; ')}.`);
  return lines.join('\n');
}
