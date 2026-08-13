/**
 * Tier-collapse rendering (D3): render a task's embedded craftbook for
 * a SMALL executor — merge to a ≤3-step linear chain, one artifact per
 * group, gates verbatim (a merged group carries every merged step's
 * completion checks + scripts), step prompts rewritten to single-action
 * imperatives. "One task model, tier-rendered": structure density is a
 * dial priced per executor tier, never a fork of the task model.
 *
 * Deliberately CONSERVATIVE in v1 — the pass collapses only books it
 * can prove it understands, and fails OPEN (`changed: false`, book
 * untouched) on anything else:
 *
 * - linear chains only: `next` edges must follow array order (or be
 *   omitted), entry must be the first step, no `branches`, no
 *   `advanceWhen.goto`, no gate routes other than `onReject: <self>`;
 * - no activation-gated steps (merging would silently drop a guard);
 * - the caller enforces single-assignee + tier gating and persists the
 *   result (see TaskManager.collapseCraftbookForTier).
 *
 * The pass is generic over the step type so a task's lifecycle fields
 * (createdAt, gateAttempts, gateAttemptHistory, …) ride through on the
 * surviving anchor steps — group id = anchor id, which keeps step
 * notes, telemetry, and gate bookkeeping keyed to a live id.
 */

import { firstActionForKind } from './deliverable.js';
import { deliverableKindForStep, stepDeliverablePath } from './deliverable.js';
import type { ModelTier } from './roles/tier.js';
import type { CraftbookStep, GateCheck, StepGateUnion } from './schemas/index.js';
import { normalizeStepGate, validateCraftbookGraph } from './schemas/index.js';

export interface CollapseCraftbookResult<S extends CraftbookStep> {
  steps: S[];
  entryStepId: string;
  /** Original step id → surviving group id (identity for anchors). */
  stepIdMap: Map<string, string>;
  changed: boolean;
  /** Why the pass declined, when it did (for the caller's log line). */
  skippedReason?: string;
}

const DEFAULT_MAX_STEPS = 3;

function hasCompletionGate(step: Pick<CraftbookStep, 'gate'>): boolean {
  if (!step.gate) return false;
  return normalizeStepGate(step.gate).at === 'completion';
}

function hasActivationGate(step: Pick<CraftbookStep, 'gate'>): boolean {
  if (!step.gate) return false;
  return normalizeStepGate(step.gate).at === 'activation';
}

/** Structural preconditions — anything false → fail-open skip. */
function collapsePreconditions(book: {
  steps: CraftbookStep[];
  entryStepId: string;
}): string | null {
  const { steps, entryStepId } = book;
  if (steps[0]?.id !== entryStepId) return 'entry step is not the first step';
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (step.branches && step.branches.length > 0) return `step "${step.id}" has branches`;
    if (step.advanceWhen?.goto) return `step "${step.id}" has an advanceWhen.goto route`;
    if (hasActivationGate(step)) return `step "${step.id}" has an activation gate`;
    if (step.next && step.next !== steps[i + 1]?.id) {
      return `step "${step.id}" has a non-linear next edge`;
    }
    if (step.gate) {
      const gate = normalizeStepGate(step.gate);
      if (gate.onReject && gate.onReject !== step.id) {
        return `step "${step.id}" gate rejects to another step`;
      }
      if (gate.onApprove && gate.onApprove !== steps[i + 1]?.id) {
        return `step "${step.id}" gate approves non-linearly`;
      }
    }
  }
  return null;
}

function dedupChecks(checks: GateCheck[]): GateCheck[] {
  const seen = new Set<string>();
  const out: GateCheck[] = [];
  for (const check of checks) {
    const key = JSON.stringify(check);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(check);
  }
  return out;
}

function gateCheckBullet(check: GateCheck): string {
  switch (check.kind) {
    case 'minBytes':
      return `\`${check.file}\` is at least ${check.bytes} bytes of real content`;
    case 'sniff':
      return `\`${check.file}\` passes the ${check.sniff} check`;
    case 'contains':
      return `\`${check.file}\` matches /${check.pattern}/`;
    case 'notContains':
      return `\`${check.file}\` does NOT match /${check.pattern}/`;
    default:
      return `${check.kind}${'file' in check && check.file ? ` on \`${check.file}\`` : ''} passes`;
  }
}

/**
 * The single-action imperative prompt for a merged group. The anchor's
 * authored procedure is kept below the imperative header — the header
 * does the collapse work (first action, one-call-per-turn, gate
 * bullets); the authored text keeps domain specifics the template
 * can't know. Merged-away steps' prose drops; their GATES do not.
 */
function collapsedPrompt(opts: {
  anchor: CraftbookStep;
  mergedNames: string[];
  checks: GateCheck[];
}): string {
  const { anchor, mergedNames, checks } = opts;
  const path = stepDeliverablePath(anchor);
  const kind = deliverableKindForStep(anchor);
  const lines: string[] = [];
  const job = anchor.description?.trim() || anchor.name;
  lines.push(job.endsWith('.') ? job : `${job}.`);
  if (path && kind) {
    lines.push(
      `Produce \`${path}\` — your first tool call is \`${firstActionForKind(kind, path)}\`. One tool call per turn.`,
    );
  }
  if (checks.length > 0) {
    const bullets = checks.slice(0, 6).map((c) => `- ${gateCheckBullet(c)}`);
    lines.push(`The gate holds this step until:\n${bullets.join('\n')}`);
  }
  lines.push('If the gate rejects, fix exactly what the verdict names — do not start over.');
  if (anchor.prompt?.trim()) {
    lines.push(`Procedure:\n${anchor.prompt.trim()}`);
  }
  if (mergedNames.length > 0) {
    lines.push(`(This step also covers: ${mergedNames.join(', ')}.)`);
  }
  return lines.join('\n\n');
}

/**
 * Collapse `book` for a small executor tier. Returns the input
 * unchanged (`changed: false`) unless `tier === 'tiny'`, the book is
 * longer than `maxSteps`, and every structural precondition holds.
 */
export function collapseCraftbookForTier<S extends CraftbookStep>(
  book: { steps: S[]; entryStepId: string },
  opts: { tier: ModelTier; maxSteps?: number },
): CollapseCraftbookResult<S> {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const unchanged = (skippedReason?: string): CollapseCraftbookResult<S> => ({
    steps: book.steps,
    entryStepId: book.entryStepId,
    stepIdMap: new Map(book.steps.map((s) => [s.id, s.id])),
    changed: false,
    ...(skippedReason ? { skippedReason } : {}),
  });

  if (opts.tier !== 'tiny') return unchanged();
  if (book.steps.length <= maxSteps) return unchanged();
  const precondition = collapsePreconditions(book);
  if (precondition) return unchanged(precondition);

  // 1. Partition into anchor groups: gateless steps merge forward into
  //    the nearest completion-gated successor; a trailing gateless tail
  //    merges backward into the last group.
  const groups: S[][] = [];
  let current: S[] = [];
  for (const step of book.steps) {
    current.push(step);
    if (hasCompletionGate(step)) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length > 0) {
    if (groups.length === 0) return unchanged('no completion-gated step to anchor on');
    groups[groups.length - 1] = [...groups[groups.length - 1]!, ...current];
  }

  // 2. Still too many groups → pairwise merge from the tail.
  while (groups.length > maxSteps) {
    const tail = groups.pop()!;
    groups[groups.length - 1] = [...groups[groups.length - 1]!, ...tail];
  }

  // 3. Build the merged steps. The group's ANCHOR is its last
  //    completion-gated member (its lifecycle fields + id survive);
  //    the group's advanceWhen is that anchor's; the combined gate
  //    carries every member's checks + scripts.
  const stepIdMap = new Map<string, string>();
  const wasTerminal = book.steps[book.steps.length - 1]?.terminal === true;
  const merged: S[] = groups.map((members, groupIdx) => {
    const anchors = members.filter((m) => hasCompletionGate(m));
    const anchor = anchors[anchors.length - 1] ?? members[members.length - 1]!;
    for (const m of members) stepIdMap.set(m.id, anchor.id);

    const checks = dedupChecks(
      members.flatMap((m) => (m.gate ? (normalizeStepGate(m.gate).checks ?? []) : [])),
    );
    const scripts = members.flatMap((m) =>
      m.gate ? (normalizeStepGate(m.gate).scripts ?? []) : [],
    );
    const dedupedScripts = scripts.filter(
      (script, i) => scripts.findIndex((s) => JSON.stringify(s) === JSON.stringify(script)) === i,
    );
    const maxAttempts = Math.max(
      0,
      ...members.map((m) => (m.gate ? (normalizeStepGate(m.gate).maxAttempts ?? 0) : 0)),
    );
    const consumes = members
      .flatMap((member) => member.consumes ?? [])
      .filter(
        (input, index, all) =>
          all.findIndex(
            (candidate) =>
              candidate.file === input.file &&
              Boolean(candidate.artifact) === Boolean(input.artifact),
          ) === index,
      );
    const isLast = groupIdx === groups.length - 1;
    const nextGroupAnchor = groups[groupIdx + 1];
    const nextId = nextGroupAnchor
      ? (nextGroupAnchor.filter((m) => hasCompletionGate(m)).slice(-1)[0] ??
        nextGroupAnchor[nextGroupAnchor.length - 1]!)
      : undefined;

    const gate: StepGateUnion = {
      at: 'completion',
      ...(checks.length > 0 ? { checks } : {}),
      ...(dedupedScripts.length > 0 ? { scripts: dedupedScripts } : {}),
      onReject: anchor.id,
      ...(maxAttempts > 0 ? { maxAttempts } : {}),
    };

    const mergedNames = members.filter((m) => m.id !== anchor.id).map((m) => m.name);
    const terminal = isLast && wasTerminal;
    const step: S = {
      ...anchor,
      prompt: collapsedPrompt({ anchor, mergedNames, checks }),
      ...(consumes.length > 0 ? { consumes } : { consumes: undefined }),
      gate,
      // Terminal + advanceWhen is an illegal combination; the terminal
      // group keeps only its completion gate.
      ...(terminal
        ? { terminal: true, advanceWhen: undefined, next: undefined }
        : {
            terminal: undefined,
            next: nextId?.id,
            advanceWhen: anchor.advanceWhen
              ? { ...anchor.advanceWhen, goto: undefined }
              : undefined,
          }),
    };
    // Strip undefined-valued keys so schema round-trips stay clean.
    for (const key of ['terminal', 'advanceWhen', 'next', 'consumes'] as const) {
      if (step[key] === undefined) delete step[key];
    }
    if (step.advanceWhen && step.advanceWhen.goto === undefined) {
      const { goto: _goto, ...rest } = step.advanceWhen;
      void _goto;
      step.advanceWhen = rest as S['advanceWhen'];
    }
    return step;
  });

  const entryStepId = stepIdMap.get(book.entryStepId) ?? merged[0]!.id;
  const problems = validateCraftbookGraph({ steps: merged, entryStepId });
  if (problems.length > 0) {
    return unchanged(`collapsed graph invalid: ${problems[0]}`);
  }
  return { steps: merged, entryStepId, stepIdMap, changed: true };
}
