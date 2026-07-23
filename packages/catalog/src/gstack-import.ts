import {
  type CraftbookDoc,
  CraftbookDocSchema,
  type HookSpec,
  type NewCraftbookStep,
  type SkillPersona,
  parseSkillDoc,
  skillToCraftbookDoc,
} from '@bendyline/gezel';

/**
 * Pure conversion logic for the shipped skill wave — shared by the
 * writer script (scripts/import-gstack-skills.ts) and the regen
 * fidelity test (gstack-import.test.ts). No fs in here: callers read
 * the snapshot and overlay files themselves.
 *
 * SOURCE CREDIT: these procedures are adapted from gstack — Garry Tan's
 * open-source "software factory" (github.com/garrytan/gstack) — the
 * snapshot of which lives under scripts/gstack-skills/. We present
 * them to users as ordinary bundled skills — the source's slash-command
 * titles ("/cso — …") and product branding are deliberately replaced
 * with plain, role-safe ids and names here. The structured `basedOn`
 * credit is the user-facing provenance record.
 */

/** Fixed so re-runs are byte-stable; bump deliberately with content changes. */
export const RELEASED_AT = '2026-07-06T00:00:00Z';
export const VERSION = '1.0.0';
export const GSTACK_BASED_ON = {
  name: 'gstack',
  url: 'https://github.com/garrytan/gstack',
} as const;

export interface WaveBook {
  /** Snapshot directory under scripts/gstack-skills/ and overlay key. */
  source: string;
  /** Gezel-native book id — plain, role-safe (never reads as a gezel role). */
  id: string;
  /** Gezel-native display name (replaces the source's slash-command title). */
  name: string;
  /** Human catalog copy shown to users; replaces the converter's auto prose. */
  description: string;
  /** Catalog browse/search tags. */
  tags: string[];
}

/**
 * The shipped wave (Waves 1+2). `id`/`name` are deliberately not the
 * source titles: `executive-level-review` and `security-architecture-review`
 * avoid colliding with gezel role names. Source credit lives in `basedOn`.
 */
export const WAVE: WaveBook[] = [
  {
    source: 'office-hours',
    id: 'idea-office-hours',
    name: 'Idea Office Hours',
    description:
      "Pressure-test a product idea with forcing questions before jumping to solutions, then capture the decision in a short design doc — a structured 'office hours' diagnostic.",
    tags: ['product', 'ideation', 'planning'],
  },
  {
    source: 'investigate',
    id: 'root-cause-investigation',
    name: 'Root-Cause Investigation',
    description:
      'Debug systematically: reproduce the failure and find the true root cause before changing any code, then fix and verify. Enforces a no-fix-without-diagnosis discipline.',
    tags: ['debugging', 'engineering'],
  },
  {
    source: 'document-generate',
    id: 'technical-documentation',
    name: 'Technical Documentation',
    description:
      'Generate a coherent documentation set from a codebase, organized by the Diataxis model (tutorials, how-to guides, reference, explanation), with cross-links and a coverage pass.',
    tags: ['documentation', 'writing'],
  },
  {
    source: 'plan-ceo-review',
    id: 'executive-level-review',
    name: 'Executive-Level Review',
    description:
      "A strategic, executive-level review of a plan or scope: challenge the premise, weigh alternatives, and score each dimension before committing — the 'should we even build this' pass.",
    tags: ['review', 'planning', 'strategy'],
  },
  {
    source: 'spec',
    id: 'spec-authoring',
    name: 'Spec Authoring',
    description:
      'Turn a rough intent into a backlog-ready spec: interrogate scope and requirements against the real code, then file a well-formed, unambiguous issue.',
    tags: ['planning', 'spec'],
  },
  {
    source: 'cso',
    id: 'security-architecture-review',
    name: 'Security Architecture Review',
    description:
      'A structured security architecture review: walk the stack for secrets, dependencies, auth, and common vulnerability classes, then report findings ranked by severity and confidence.',
    tags: ['security', 'review'],
  },
  {
    source: 'design-consultation',
    id: 'design-system-consultation',
    name: 'Design System Consultation',
    description:
      'Interview for product context and taste, then propose a full design system — type, color, layout, motion — and capture it as a DESIGN.md with live preview pages.',
    tags: ['design'],
  },
  {
    source: 'qa-only',
    id: 'browser-qa-audit',
    name: 'Browser QA Audit',
    description:
      'Exercise a running app in a real browser, triage what breaks, and produce a report-only QA findings list with a health score — no code changes.',
    tags: ['qa', 'testing'],
  },
  {
    source: 'retro',
    id: 'engineering-retrospective',
    name: 'Engineering Retrospective',
    description:
      'Build a data-grounded engineering retrospective from git history: activity, hotspots, review patterns, and per-person growth notes for a given window.',
    tags: ['retrospective', 'engineering'],
  },
];

export interface Overlay {
  frozen?: boolean;
  set?: Partial<CraftbookDoc>;
  planAppend?: string;
  steps?: Record<string, Partial<NewCraftbookStep> | null>;
  scripts?: Record<string, string | null>;
  hooks?: HookSpec[];
}

export function applyOverlay(doc: CraftbookDoc, overlay: Overlay): CraftbookDoc {
  const out: Record<string, unknown> = { ...doc, ...(overlay.set ?? {}) };
  if (overlay.planAppend) {
    const plan = typeof out.plan === 'string' && out.plan.length > 0 ? `${out.plan}\n\n` : '';
    out.plan = `${plan}${overlay.planAppend}`;
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
  book: WaveBook,
  raw: string,
  overlay: Overlay,
): ConvertedWaveBook {
  const skill = parseSkillDoc(raw, { fallbackName: book.source });
  const conversion = skillToCraftbookDoc(skill, {
    releasedAt: RELEASED_AT,
    omitProvenance: true,
  });
  const doc = CraftbookDocSchema.parse({
    ...conversion.doc,
    id: book.id,
    name: book.name,
    description: book.description,
    basedOn: GSTACK_BASED_ON,
    command: book.id,
    version: VERSION,
  });
  return {
    doc: applyOverlay(doc, overlay),
    ...(conversion.persona ? { persona: conversion.persona } : {}),
    notes: conversion.notes,
  };
}
