import type { KeurmeesterAction, KeurmeesterTriggerKind } from '@bendyline/gezel';

/**
 * Curated about.md prose for a freshly-provisioned Keurmeester gezel.
 * Second-person voice (matches the about.md convention — injected into the
 * system prompt verbatim). The Keurmeester is the guild's quality inspector:
 * consulted out-of-band when a smaller model's work has stalled, looping, or
 * drifted, and the engine's own recovery budget is spent. Character and
 * operating rules only — the tool listing is injected at session-build time.
 *
 * This constant is the canonical copy; the gilde template at
 * packages/catalog/data/gezel-templates/ke/keurmeester/ ships the same
 * prose for discoverability. Keep them in sync when editing.
 */
export const KEURMEESTER_ABOUT_MD = `## Identity

You are the **Keurmeester** — the guild's quality inspector. When a journeyman's work stalls, loops, or drifts off the mark, you are called in to look over their shoulder. You are exacting but kind: the goal is always to get the journeyman moving again with their dignity intact, not to take over their bench.

## Expertise

- **Diagnosis before action.** You read the transcript, the tool calls, and the task as given before you conclude anything. The symptom (silence, repetition, drift) is not the cause; you name the cause.
- **Smallest effective intervention.** A well-aimed sentence beats a rewritten task; a rewritten task beats doing the work yourself. You escalate only when the smaller remedy has demonstrably failed.
- **Task shaping.** You know how work must be cut for a smaller mind to hold it: one deliverable per step, concrete file paths, verifiable gates, no implied sub-goals. When a task keeps defeating its assignee, the task is usually the defect.
- **Honest limits.** Some failures are beyond prompting — the model cannot do the thing. You say so plainly and either do that one step yourself or recommend a pause, rather than sending the journeyman back to fail again.

## Working style

- **Hand the work back.** Every intervention ends with the original assignee holding the task. You never keep it.
- **No credit-taking.** The journeyman's work stays theirs. Your notes describe what changed and why, never who was cleverer.
- **Verdicts are structured.** When consulted, you answer in the exact format requested — a diagnosis, a failure class, one action, a confidence. No essays around it.
- **Stand down when standing down is right.** An infrastructure failure, a genuinely finished task, or a problem the user must decide — these get \`stand_down\`, not a forced intervention.
`;

/**
 * First names for auto-naming a fresh Keurmeester. Same shape as the
 * Meester/Klerk lists — first names only, warm, drawn from a distinct pool
 * so a default install never feels like duplicates.
 */
export const KEURMEESTER_NAMES = [
  'Aldert',
  'Baruch',
  'Berend',
  'Cornelia',
  'Diederik',
  'Egbert',
  'Femke',
  'Geertje',
  'Godfried',
  'Hendrika',
  'Ivo',
  'Jacoba',
  'Koenraad',
  'Leontine',
  'Maarten',
  'Nelleke',
  'Okke',
  'Petronella',
  'Quirijn',
  'Reinout',
  'Saskia',
  'Tjeerd',
  'Ursula',
  'Volkert',
  'Wilhelmina',
  'Ysbrand',
  'Zwaantje',
];

export function randomKeurmeesterName(): string {
  const i = Math.floor(Math.random() * KEURMEESTER_NAMES.length);
  return KEURMEESTER_NAMES[i] ?? 'Keurmeester';
}

/**
 * Everything the Keurmeester gets to see about a struggling session. All
 * strings are pre-truncated by the caller — the consult prompt is sent to a
 * frontier model and should stay well under ~30k chars.
 */
export interface KeurmeesterConsultBundle {
  trigger: KeurmeesterTriggerKind;
  /** Human-readable one-liner: what tripped the trigger. */
  triggerSummary: string;
  /** Struggling model identification. */
  providerName: string;
  model?: string;
  modelTier?: string;
  /** Name + role of the struggling gezel. */
  gezelName: string;
  gezelRole?: string;
  /** Recent transcript, oldest first, already truncated per message. */
  transcript: Array<{ role: string; content: string; toolCalls?: string[] }>;
  /** Compact tool-call trace for the failing stretch: "name(argHint) → ok|error". */
  toolTrace: string[];
  /** Detector signals: continuations used, nudges sent, plateau duration, … */
  signals: Record<string, unknown>;
  /** Task context, when the session is task-scoped. */
  task?: {
    name: string;
    stepId?: string;
    stepName?: string;
    stepPrompt?: string;
    gateSummary?: string;
    craftbookMarkdown?: string;
  };
}

/**
 * The Keurmeester's own bounded execution turn. The hard scope rule is
 * load-bearing: a takeover that wanders past the failing step defeats
 * the "hand the work back" contract and burns frontier tokens on work
 * the journeyman could do.
 */
export function buildTakeoverPrompt(args: {
  instruction: string;
  taskTitle: string;
  taskRef: string;
  stepName: string;
  stepPrompt: string;
  deliverable?: string;
}): string {
  return [
    `You are taking over ONE failing step of task "${args.taskTitle}" (${args.taskRef}). The assigned journeyman could not complete it even with guidance; you perform exactly this step yourself, then stop.`,
    '',
    `## The step: ${args.stepName}`,
    args.stepPrompt,
    ...(args.deliverable ? ['', `Expected deliverable: ${args.deliverable}`] : []),
    '',
    '## Your instruction from the consult verdict',
    args.instruction,
    '',
    "Hard rules: produce ONLY this step's deliverable using your tools, then stop. Do not advance the task, do not start other steps, do not refactor unrelated work. Keep any closing remark to one sentence.",
  ].join('\n');
}

/**
 * The note the Keurmeester sends the original assignee after an
 * intervention, so the work lands back in the journeyman's hands with
 * a concrete pointer at what changed.
 */
export function buildHandbackNote(args: {
  kind: 'rewrite_step' | 'rewrite_craftbook' | 'takeover_step';
  taskRef: string;
  stepName: string;
  detail: string;
}): string {
  switch (args.kind) {
    case 'rewrite_step':
      return `I looked over the stalled step "${args.stepName}" on ${args.taskRef} and rewrote its instructions to be more concrete. ${args.detail} Please pick the step up again from the revised instructions.`;
    case 'rewrite_craftbook':
      return `The plan for ${args.taskRef} kept defeating the current step, so I reshaped the craftbook. ${args.detail} Please continue from the active step — the instructions there are new.`;
    case 'takeover_step':
      return `I completed the step "${args.stepName}" on ${args.taskRef} myself — ${args.detail} Please continue from the next step; the task is yours again.`;
  }
}

const ACTION_DESCRIPTIONS: Record<KeurmeesterAction['kind'], string> = {
  corrective_prompt:
    '`{"kind":"corrective_prompt","prompt":"…"}` — one direct message sent to the struggling model as its very next instruction. Name the specific blocker and the specific next tool call. This is almost always the right first intervention.',
  rewrite_step:
    '`{"kind":"rewrite_step","stepId":"…","prompt":"…","name":"…?","deliverable":"…?"}` — replace the current task step\'s instructions (and optionally its deliverable) so the model cannot "finish" without closing the real goal.',
  rewrite_craftbook:
    '`{"kind":"rewrite_craftbook","document":"…","rationale":"…"}` — replace the task\'s whole craftbook with a reshaped one (markdown document form). Use when the task structure itself keeps defeating the model.',
  takeover_step:
    '`{"kind":"takeover_step","instruction":"…"}` — you perform ONLY the failing step yourself, then hand back. Reserve for capability ceilings: the model was told exactly what is wrong and still cannot do it.',
  stand_down:
    '`{"kind":"stand_down","reason":"…"}` — no intervention. Correct when the failure is infrastructure, the work is actually done, or only the user can decide.',
};

/**
 * Build the one-shot consult prompt. `allowedActions` grows as later
 * phases ship — the prompt only ever offers actions the engine can
 * currently apply, so the verdict never has to be silently downgraded.
 */
export function buildConsultPrompt(
  bundle: KeurmeesterConsultBundle,
  allowedActions: Array<KeurmeesterAction['kind']>,
): string {
  const lines: string[] = [];
  lines.push(
    'A smaller model working in this guild has stalled and its automatic recovery budget is spent. You are consulted as Keurmeester. Diagnose why it is stuck and choose exactly one action.',
    '',
    '## The struggling journeyman',
    `- Gezel: ${bundle.gezelName}${bundle.gezelRole ? ` (${bundle.gezelRole})` : ''}`,
    `- Model: ${bundle.providerName}${bundle.model ? ` / ${bundle.model}` : ''}${bundle.modelTier ? ` (tier: ${bundle.modelTier})` : ''}`,
    `- Trigger: ${bundle.trigger} — ${bundle.triggerSummary}`,
  );

  const signalEntries = Object.entries(bundle.signals);
  if (signalEntries.length > 0) {
    lines.push('', '## Detector signals');
    for (const [k, v] of signalEntries) {
      lines.push(`- ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    }
  }

  if (bundle.task) {
    lines.push('', '## Task context', `- Task: ${bundle.task.name}`);
    if (bundle.task.stepName || bundle.task.stepId) {
      lines.push(`- Current step: ${bundle.task.stepName ?? bundle.task.stepId}`);
    }
    if (bundle.task.stepPrompt) {
      lines.push('', '### Step instructions as given', bundle.task.stepPrompt);
    }
    if (bundle.task.gateSummary) {
      lines.push('', '### Gate state', bundle.task.gateSummary);
    }
    if (bundle.task.craftbookMarkdown) {
      lines.push('', '### Craftbook (current)', bundle.task.craftbookMarkdown);
    }
  }

  if (bundle.toolTrace.length > 0) {
    lines.push('', '## Tool-call trace (failing stretch)');
    for (const t of bundle.toolTrace) lines.push(`- ${t}`);
  }

  lines.push('', '## Recent transcript (oldest first)');
  for (const m of bundle.transcript) {
    const tools = m.toolCalls?.length ? ` [tools: ${m.toolCalls.join(', ')}]` : '';
    lines.push(`### ${m.role}${tools}`, m.content.trim() === '' ? '(empty)' : m.content, '');
  }

  lines.push(
    '## Available actions',
    ...allowedActions.map((kind) => `- ${ACTION_DESCRIPTIONS[kind]}`),
    '',
    '## Answer format',
    'Reply with ONLY a fenced json block containing exactly this shape — no prose before or after:',
    '```json',
    '{',
    '  "diagnosis": "one or two sentences naming the root cause",',
    '  "failureClass": "silent_stall | tool_loop | capability_ceiling | task_shape | context_pressure | unknown",',
    '  "action": { "kind": "…", … },',
    '  "confidence": "low | medium | high"',
    '}',
    '```',
    '',
    "Rules: pick the smallest action that plausibly unblocks the journeyman. A corrective prompt must name the concrete next step (which tool, which file), not restate the goal. If the failure is not the model's fault, stand down.",
  );

  return lines.join('\n');
}
