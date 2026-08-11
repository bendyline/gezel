import {
  type CraftbookDoc,
  CraftbookDocSchema,
  type GateCheck,
  GateCheckSchema,
  HookSpecSchema,
  type NewCraftbookStep,
  NewCraftbookStepSchema,
  type SkillPersona,
  parseSkillDoc,
  skillToCraftbookDoc,
} from '@bendyline/gezel';
import { z } from 'zod';
import type { GstackWaveBook, GstackWaveConfig } from './gstack-authoring.js';

/**
 * Pure conversion logic for the shipped skill wave — shared by the
 * writer script (scripts/import-gstack-skills.ts) and the regen
 * fidelity test (gstack-import.test.ts). No fs in here: callers read the
 * snapshot and overlay files from Gilde's `authoring/gstack/` tree.
 *
 * SOURCE CREDIT: these procedures are adapted from gstack — Garry Tan's
 * open-source "software factory" (github.com/garrytan/gstack). Gilde's
 * authoring/gstack tree owns the snapshot, release mapping, and structured
 * `basedOn` credit. The converter remains here because it uses Gezel's skill
 * parser and craftbook runtime schemas.
 */

/**
 * Build the catalog identity without erasing fields owned by later curation
 * passes. Importers own the stable name/search copy; role, artwork, yanks,
 * and other identity metadata survive every append-only version generation.
 */
export function mergeWaveIdentity(
  existing: Record<string, unknown>,
  book: GstackWaveBook,
  doc: CraftbookDoc,
): Record<string, unknown> {
  return {
    ...existing,
    schemaVersion: 1,
    kind: 'craftbook-template',
    id: book.id,
    name: book.name,
    description: firstSentence(doc.description ?? book.name),
    tags: book.tags,
    maintainer: existing.maintainer ?? { name: 'Gezel' },
    license: existing.license ?? 'MIT',
    yankedVersions: existing.yankedVersions ?? [],
  };
}

function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const period = flat.indexOf('. ');
  const cut = period > 20 ? flat.slice(0, period + 1) : flat;
  return cut.length > 180 ? `${cut.slice(0, 177)}...` : cut;
}

export const QualityPatternSchema = z
  .object({
    /** Runtime regular expression used by the deterministic contains check. */
    pattern: z.string().min(1),
    /** Repair-grade name shown when the check rejects the step. */
    label: z.string().min(1),
  })
  .strict();
export type QualityPattern = z.infer<typeof QualityPatternSchema>;

export const QualityOutputSchema = z
  .object({
    /** Stable workspace-relative handoff path. */
    path: z.string().min(1),
    /** A meaningful floor, not merely proof that a file exists. */
    minBytes: z.number().int().positive(),
    /** Cheap structural checks that run before a reviewer sees the work. */
    requiredPatterns: z.array(QualityPatternSchema).optional(),
    /** Extra domain checks such as htmlLint or totalMinBytes. */
    additionalChecks: z.array(GateCheckSchema).optional(),
  })
  .strict();
export type QualityOutput = z.infer<typeof QualityOutputSchema>;

export const QualityPhaseSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    suggestedRole: z.string().min(1),
    prompt: z.string().min(1),
    output: QualityOutputSchema,
  })
  .strict();
export type QualityPhase = z.infer<typeof QualityPhaseSchema>;

export const QualityReviewSchema = z
  .object({
    /** Primary artifact repaired when review rejects the work. */
    artifactPath: z.string().min(1),
    /** Other files the reviewer must inspect and the repairer must keep aligned. */
    relatedPaths: z.array(z.string().min(1)).optional(),
    reviewPath: z.string().min(1),
    reviewerRole: z.string().min(1).optional(),
    repairRole: z.string().min(1).optional(),
    minReviewBytes: z.number().int().positive().optional(),
    criteria: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type QualityReview = z.infer<typeof QualityReviewSchema>;

export const QualityWorkflowSchema = z
  .object({
    plan: z.string().min(1),
    phases: z.array(QualityPhaseSchema).min(1),
    review: QualityReviewSchema,
    /** Deterministic gate rejections before the runtime pauses for help. */
    maxGateAttempts: z.number().int().positive().optional(),
    /** Human-review cycles before the workflow exits with concerns. */
    maxReviewRounds: z.number().int().positive().optional(),
  })
  .strict();
export type QualityWorkflow = z.infer<typeof QualityWorkflowSchema>;

/** Runtime contract for Gilde-authored overlays; rejects typos before any write. */
export const OverlaySchema = z
  .object({
    frozen: z.boolean().optional(),
    set: CraftbookDocSchema.partial().strict().optional(),
    planAppend: z.string().min(1).optional(),
    /**
     * A compact, Gezel-native workflow. When present it replaces the raw
     * snapshot's plan and steps; the snapshot remains only the credited source
     * material. Shared expansion keeps gates, review, repair, and escalation
     * behavior consistent across this imported wave.
     */
    workflow: QualityWorkflowSchema.optional(),
    steps: z.record(z.string(), NewCraftbookStepSchema.partial().strict().nullable()).optional(),
    scripts: z.record(z.string(), z.string().nullable()).optional(),
    hooks: z.array(HookSpecSchema).optional(),
  })
  .strict();
export type Overlay = z.infer<typeof OverlaySchema>;

const QUALITY_RESERVED_STEP_IDS = new Set(['evaluate', 'repair', 'finish', 'needs-user']);

/** Expand the compact overlay form into a complete, testable task graph. */
export function qualityWorkflowSteps(workflow: QualityWorkflow): NewCraftbookStep[] {
  if (workflow.phases.length === 0) {
    throw new Error('quality workflow needs at least one working phase');
  }
  if (!Number.isInteger(workflow.maxGateAttempts ?? 3) || (workflow.maxGateAttempts ?? 3) < 1) {
    throw new Error('quality workflow maxGateAttempts must be a positive integer');
  }
  if (!Number.isInteger(workflow.maxReviewRounds ?? 3) || (workflow.maxReviewRounds ?? 3) < 1) {
    throw new Error('quality workflow maxReviewRounds must be a positive integer');
  }
  if (workflow.review.criteria.length === 0) {
    throw new Error('quality workflow review needs at least one criterion');
  }
  if (!workflow.review.reviewPath.trim()) {
    throw new Error('quality workflow review needs a reviewPath');
  }

  const ids = new Set<string>();
  for (const phase of workflow.phases) {
    if (!phase.id.trim()) throw new Error('quality workflow phase id cannot be empty');
    if (QUALITY_RESERVED_STEP_IDS.has(phase.id)) {
      throw new Error(`quality workflow phase id "${phase.id}" is reserved`);
    }
    if (ids.has(phase.id)) throw new Error(`duplicate quality workflow phase id "${phase.id}"`);
    ids.add(phase.id);
    if (!phase.suggestedRole.trim()) {
      throw new Error(`quality workflow phase "${phase.id}" needs a suggestedRole`);
    }
    if (!phase.output.path.trim() || phase.output.minBytes < 1) {
      throw new Error(`quality workflow phase "${phase.id}" needs a gated output`);
    }
  }

  const lastOutput = workflow.phases.at(-1)!.output;
  if (workflow.review.artifactPath !== lastOutput.path) {
    throw new Error(
      `quality workflow review artifact "${workflow.review.artifactPath}" must match final phase output "${lastOutput.path}"`,
    );
  }

  const maxGateAttempts = workflow.maxGateAttempts ?? 3;
  const maxReviewRounds = workflow.maxReviewRounds ?? 3;
  const phases = workflow.phases.map((phase, index): NewCraftbookStep => {
    const next = workflow.phases[index + 1]?.id ?? 'evaluate';
    return {
      id: phase.id,
      name: phase.name,
      description: phase.description,
      prompt: `${phase.prompt.trim()}\n\nObservable handoff: write the completed result to \`${phase.output.path}\` in the workspace. Do not merely describe what the file would contain. Re-read it before finishing this phase and repair any incomplete sections.`,
      suggestedRole: phase.suggestedRole,
      advanceWhen: {
        file: phase.output.path,
        minBytes: phase.output.minBytes,
        sniff: 'nonempty',
        requireChange: true,
        goto: next,
      },
      gate: qualityOutputGate(phase.output, phase.id, maxGateAttempts),
      next,
    };
  });

  const relatedPaths = workflow.review.relatedPaths ?? [];
  const reviewTargets = [workflow.review.artifactPath, ...relatedPaths]
    .map((path) => `\`${path}\``)
    .join(', ');
  const criteria = workflow.review.criteria
    .map((criterion, i) => `${i + 1}. ${criterion}`)
    .join('\n');

  return [
    ...phases,
    {
      id: 'evaluate',
      name: 'Evaluate the deliverable',
      description:
        'Independently grade the observable deliverable and route it to finish, repair, or user escalation.',
      prompt: `Review ${reviewTargets} against every criterion below. Inspect the underlying evidence files named by the workflow; do not grade from the author's summary alone.\n\n${criteria}\n\nWrite an evidence-backed review to \`${workflow.review.reviewPath}\`. Give each criterion a PASS or FAIL with a concrete path, excerpt, measurement, or observed behavior. End with exactly \`Verdict: PASS\` or \`Verdict: REVISE\`. Then use \`advance_task_step\` for the active task: PASS routes to \`finish\`; REVISE routes to \`repair\` for review rounds 1 through ${Math.max(1, maxReviewRounds - 1)}, and the ${maxReviewRounds}th REVISE routes to \`needs-user\`. Never route to finish while a criterion is unmet.`,
      suggestedRole: workflow.review.reviewerRole ?? 'reviewer',
      gate: {
        at: 'completion',
        checks: [
          {
            kind: 'minBytes',
            file: workflow.review.reviewPath,
            bytes: workflow.review.minReviewBytes ?? 400,
          },
          {
            kind: 'contains',
            file: workflow.review.reviewPath,
            pattern: 'Verdict:\\s*(?:PASS|REVISE)',
            flags: 'i',
            label: 'explicit PASS or REVISE verdict',
          },
        ],
        onReject: 'evaluate',
        maxAttempts: maxGateAttempts,
      },
      next: 'repair',
    },
    {
      id: 'repair',
      name: 'Repair the deliverable',
      description: 'Fix only the concrete gaps from the latest independent review.',
      prompt: `Read \`${workflow.review.reviewPath}\` and repair every failed criterion in ${reviewTargets}. Make the changes in the actual workspace files, not just in task notes or a reply. Preserve evidence that already passed. Re-run or re-check anything the reviewer found unproven. Ensure \`${workflow.review.artifactPath}\` is genuinely updated this turn so the repair is observable, then hand it back for independent evaluation.`,
      suggestedRole: workflow.review.repairRole ?? workflow.phases.at(-1)!.suggestedRole,
      advanceWhen: {
        file: workflow.review.artifactPath,
        minBytes: lastOutput.minBytes,
        sniff: 'nonempty',
        requireChange: true,
        goto: 'evaluate',
      },
      gate: qualityOutputGate(lastOutput, 'repair', maxGateAttempts),
      next: 'evaluate',
    },
    {
      id: 'finish',
      name: 'Finish',
      description: 'All deterministic and reviewer criteria passed.',
      prompt: `The independent review passed. Read \`${workflow.review.reviewPath}\`, then use \`write_task_note\` to record a concise DONE summary with the final deliverable paths (${reviewTargets}) and the evidence that each acceptance criterion passed. Report DONE without starting new work.`,
      suggestedRole: 'project lead',
      terminal: true,
    },
    {
      id: 'needs-user',
      name: 'Escalate unresolved concerns',
      description: 'The bounded repair loop ended without a defensible pass.',
      prompt: `The deliverable did not pass after ${maxReviewRounds} review rounds. Do not claim success. Read \`${workflow.review.reviewPath}\`, then use \`write_task_note\` to record DONE_WITH_CONCERNS: the unmet criteria, what was attempted, the affected paths, and the smallest user decision or missing input needed to continue.`,
      suggestedRole: 'project lead',
      terminal: true,
    },
  ];
}

function qualityOutputGate(
  output: QualityOutput,
  onReject: string,
  maxAttempts: number,
): NonNullable<NewCraftbookStep['gate']> {
  const checks: GateCheck[] = [
    { kind: 'minBytes', file: output.path, bytes: output.minBytes },
    { kind: 'sniff', file: output.path, sniff: 'nonempty' },
    ...(output.requiredPatterns ?? []).map(
      ({ pattern, label }): GateCheck => ({
        kind: 'contains',
        file: output.path,
        pattern,
        flags: 'im',
        label,
      }),
    ),
    ...(output.additionalChecks ?? []),
  ];
  return { at: 'completion', checks, onReject, maxAttempts };
}

export function applyOverlay(doc: CraftbookDoc, overlay: Overlay): CraftbookDoc {
  const out: Record<string, unknown> = { ...doc, ...(overlay.set ?? {}) };
  if (overlay.planAppend) {
    const plan = typeof out.plan === 'string' && out.plan.length > 0 ? `${out.plan}\n\n` : '';
    out.plan = `${plan}${overlay.planAppend}`;
  }
  if (overlay.workflow) {
    out.plan = overlay.workflow.plan;
    out.entryStepId = overlay.workflow.phases[0]?.id;
    out.steps = qualityWorkflowSteps(overlay.workflow);
  }
  if (overlay.steps) {
    const steps = (out.steps as NewCraftbookStep[]).flatMap((step) => {
      const patch = overlay.steps?.[step.id ?? ''];
      if (patch === null) return [];
      if (patch === undefined) return [step];
      return [{ ...step, ...patch } as NewCraftbookStep];
    });
    out.steps = steps;
  }
  if (overlay.scripts) {
    const scripts = { ...((out.scripts as Record<string, string>) ?? {}) };
    for (const [name, body] of Object.entries(overlay.scripts)) {
      if (body === null) delete scripts[name];
      else scripts[name] = body;
    }
    out.scripts = Object.keys(scripts).length > 0 ? scripts : undefined;
  }
  if (overlay.hooks) out.hooks = overlay.hooks;
  return CraftbookDocSchema.parse(out);
}

export interface ConvertedWaveBook {
  doc: CraftbookDoc;
  persona?: SkillPersona;
  /** Converter honesty ledger — surfaced in the writer's dry-run log only. */
  notes: string[];
}

/**
 * Convert one snapshot skill to its shipped doc, applying the wave's
 * plain id/name/description/command and dropping the conversion
 * provenance so the book reads as an ordinary skill. The regen test
 * drives this directly to prove committed bytes match a fresh run.
 */
export function convertSnapshotSkill(
  book: GstackWaveBook,
  raw: string,
  overlay: Overlay,
  wave: GstackWaveConfig,
): ConvertedWaveBook {
  const skill = parseSkillDoc(raw, { fallbackName: book.source });
  const conversion = skillToCraftbookDoc(skill, {
    releasedAt: wave.releasedAt,
    omitProvenance: true,
  });
  const doc = CraftbookDocSchema.parse({
    ...conversion.doc,
    id: book.id,
    name: book.name,
    description: book.description,
    basedOn: wave.basedOn,
    command: book.id,
    version: wave.version,
  });
  return {
    doc: applyOverlay(doc, overlay),
    ...(conversion.persona ? { persona: conversion.persona } : {}),
    notes: conversion.notes,
  };
}
