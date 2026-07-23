import { valueGrounding, wordBand } from '@bendyline/gezel/checks';
import { postMissingDeliverableFeedback, postSniffFeedback } from '../sniff-feedback.ts';
import type { SniffResult } from '../success-check.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';
import { findWorkspaceDeliverableNearMiss } from './helpers.ts';

/**
 * Constrained-comms (D2 class 5) — draft customer comms under HARD
 * constraints: a word band, required disclosures, banned claims, and
 * grounding against the seeded facts (with a stale decoy draft whose
 * wrong number and banned sentence must NOT leak into the new notice).
 *
 * Axis: constraint-following in prose. The code suite never asks for
 * "between 140 and 220 words, must say X, must never say Y" — real
 * comms work is exactly that shape, and the DS4 sweep's
 * writing-judgment failures are the standing evidence this needs eval
 * pressure. All gates are mechanical (wordBand / contains / notContains /
 * valueGrounding); tone is the advisory judge-gate's job on the
 * product side, never the grader's.
 *
 * Grader notes:
 *   - `checkCustomerNotice` is pure (markdown in, sniff out) and
 *     exported so the reference test drives it without a daemon.
 *   - The decoy draft plants "83 minutes" and a banned guarantee
 *     sentence — copying from the old notice instead of the incident
 *     brief flips the grounding signal with the model's own value
 *     named in the feedback (the decoy-research lesson).
 */

const PROJECT_NAME = 'Driftwater Outage Notice';
const WRITER_NAME = 'Wren';
export const NOTICE_PATH = 'customer-notice.md';

// ─────────────────────────────────────────────────────────────────────
// Seeded corpus. Small but decoy-bearing.

export const COMMS_SEED_FILES: Array<{ path: string; content: string }> = [
  {
    path: 'facts/incident-brief.md',
    content: [
      '# Incident brief — checkout outage (internal)',
      '',
      '- Date: 2026-06-30, 14:02–14:40 UTC.',
      '- Duration: 38 minutes of checkout unavailability.',
      '- Scope: about 12% of customers saw failed checkouts; browsing was unaffected.',
      '- Root cause: an expired TLS certificate on the checkout gateway.',
      '- Fix: certificate renewed; automatic renewal and expiry monitoring are now in place.',
      '- Goodwill: affected customers receive a one-month service credit, applied automatically.',
      '- No customer payment data was accessed or exposed at any point.',
    ].join('\n'),
  },
  {
    path: 'facts/legal-requirements.md',
    content: [
      '# Legal requirements for the customer notice',
      '',
      'REQUIRED disclosures — the notice must state each of these:',
      '1. The incident window: June 30 and the 38-minute duration.',
      '2. The exact sentence fragment: "No customer payment data was accessed".',
      '3. The support contact: support@driftwater.example.',
      '',
      'BANNED claims — the notice must NOT contain any of these words/phrases:',
      '- "guarantee" (any form)',
      '- "never happen again"',
      '- "100% secure"',
      '- "unhackable"',
    ].join('\n'),
  },
  {
    path: 'facts/voice-guide.md',
    content: [
      '# Voice guide',
      '',
      'Calm, accountable, customer-first. Say what happened, what it meant for the',
      'customer, what we did, and what we are doing next. No defensiveness, no',
      'marketing spin, no exclamation marks. Short sentences beat long ones.',
    ].join('\n'),
  },
  {
    path: 'drafts/old-notice.md',
    content: [
      '# DRAFT (stale — do not reuse numbers)',
      '',
      'On June 30 our checkout was down for 83 minutes. We guarantee this will',
      'never happen again. We take security seriously!',
    ].join('\n'),
  },
];

// ─────────────────────────────────────────────────────────────────────
// User-shaped texts, exported so evidenceTexts and setup can't drift.

export const COMMS_MISSION_OBJECTIVES = [
  'Publish a customer notice at customer-notice.md about the June 30 checkout outage.',
  'It must be between 140 and 220 words; state the incident window (June 30, 38 minutes);',
  'include the sentence "No customer payment data was accessed"; name the support contact',
  'support@driftwater.example; and mention the one-month service credit. It must not use',
  'the words "guarantee", "never happen again", "100% secure", or "unhackable".',
  'Numbers come from facts/incident-brief.md — the old draft in drafts/ is stale.',
].join(' ');

export const COMMS_KICKOFF_MESSAGE = [
  'Please write the customer notice for the June 30 checkout outage as',
  '`customer-notice.md` (workspace root). Read facts/incident-brief.md,',
  'facts/legal-requirements.md, and facts/voice-guide.md first — every number and',
  'required disclosure comes from those files. The old drafts/old-notice.md is STALE:',
  'its duration is wrong and it uses banned wording, so do not copy from it.',
  'Hard constraints: 140–220 words; state the incident window (June 30, 38 minutes);',
  'include the exact sentence "No customer payment data was accessed"; give the',
  'support contact support@driftwater.example; mention the one-month service credit;',
  'and never use "guarantee", "never happen again", "100% secure", or "unhackable".',
  'Write the complete notice now with writeFile.',
].join(' ');

// ─────────────────────────────────────────────────────────────────────
// Pure grader.

const REQUIRED_DISCLOSURES: Array<{ signal: string; re: RegExp; ask: string }> = [
  {
    signal: 'payment-data-disclosure',
    re: /no customer payment data was accessed/i,
    ask: 'include the exact sentence "No customer payment data was accessed"',
  },
  {
    signal: 'support-contact',
    re: /support@driftwater\.example/i,
    ask: 'name the support contact support@driftwater.example',
  },
  {
    signal: 'service-credit',
    re: /one[- ]month service credit/i,
    ask: 'mention the one-month service credit',
  },
];

const BANNED_CLAIMS: Array<{ signal: string; re: RegExp; label: string }> = [
  { signal: 'no-guarantee', re: /guarante/i, label: '"guarantee"' },
  { signal: 'no-never-again', re: /never happen again/i, label: '"never happen again"' },
  { signal: 'no-100-secure', re: /100%\s*secure/i, label: '"100% secure"' },
  { signal: 'no-unhackable', re: /unhackable/i, label: '"unhackable"' },
];

export function checkCustomerNotice(markdown: string): SniffResult {
  const signals: string[] = [];
  let failReason: string | undefined;
  const fail = (reason: string) => {
    failReason ??= reason;
  };

  const band = wordBand(markdown, { min: 140, max: 220 });
  if (band.ok) signals.push('word-band');
  else fail(`word band violated: ${band.detail} — the notice must be 140-220 words`);

  for (const d of REQUIRED_DISCLOSURES) {
    if (d.re.test(markdown)) signals.push(d.signal);
    else fail(`missing required disclosure: ${d.ask}`);
  }

  for (const b of BANNED_CLAIMS) {
    if (!b.re.test(markdown)) signals.push(b.signal);
    else fail(`banned claim present: the notice must not use ${b.label}`);
  }

  const grounding = valueGrounding(markdown, [
    {
      id: 'duration',
      label: 'outage duration',
      required: ['38[- ]minute', '38 minutes'],
      forbidden: ['83[- ]minute', '83 minutes'],
    },
    { id: 'date', label: 'incident date', required: ['june\\s*30', '2026-06-30'] },
  ]);
  if (grounding.ok) signals.push('grounded-facts');
  else
    fail(
      `fact grounding failed: ${grounding.detail} (numbers come from facts/incident-brief.md, not the stale draft)`,
    );

  const requiredCount = 1 + REQUIRED_DISCLOSURES.length + BANNED_CLAIMS.length + 1;
  return {
    ok: signals.length >= requiredCount,
    signals,
    score: signals.length,
    ...(failReason ? { failReason } : {}),
  };
}

export function commsRepairDirective(): string {
  return [
    `Patch \`${NOTICE_PATH}\` to fix exactly the named gap — re-read facts/incident-brief.md`,
    'and facts/legal-requirements.md for the correct numbers and required wording. Keep the',
    'notice between 140 and 220 words. Your next tool call should be writeFile (or',
    'replaceInFile) on customer-notice.md.',
  ].join(' ');
}

// ─────────────────────────────────────────────────────────────────────
// Harness plumbing.

async function findProjectId(client: EvalContext['client']): Promise<string | null> {
  const { projects } = await client.listProjects();
  return projects.find((p) => p.name === PROJECT_NAME)?.id ?? null;
}

async function readWorkspaceText(
  client: EvalContext['client'],
  projectId: string,
  filePath: string,
): Promise<string | null> {
  try {
    const blob = await client.fetchProjectWorkspaceBlob(projectId, filePath);
    return await blob.text();
  } catch {
    return null;
  }
}

async function setup({ client, log }: EvalContext): Promise<void> {
  let projectId = await findProjectId(client);
  if (!projectId) {
    const created = await client.createProject({
      name: PROJECT_NAME,
      about:
        'Customer communications for the June 30 checkout outage. The notice must follow ' +
        'the legal requirements and voice guide in facts/, grounded in the incident brief.',
      missionObjectives: COMMS_MISSION_OBJECTIVES,
    });
    projectId = created.id;
    log(`[scenario:setup] created project name="${PROJECT_NAME}" id=${projectId}`);
  }
  if (!projectId) throw new Error('constrained-comms setup: failed to resolve project id');

  for (const f of COMMS_SEED_FILES) {
    await client.writeProjectWorkspaceFile(projectId, f);
  }
  log(`[scenario:setup] seeded ${COMMS_SEED_FILES.length} corpus files`);

  let writer: { id: string };
  try {
    const created = await client.createGezel({ name: WRITER_NAME, role: 'Copywriter' });
    writer = { id: created.id };
    log(`[scenario:setup] created copywriter "${WRITER_NAME}" id=${writer.id}`);
  } catch (err) {
    const { gezels } = await client.listGezels();
    const existing = gezels.find((g) => g.name === WRITER_NAME);
    if (!existing) throw err;
    writer = { id: existing.id };
  }
  await client.addGezelToProject(projectId, writer.id);
  await client.sendChatMessage(writer.id, { message: COMMS_KICKOFF_MESSAGE, projectId });
  log(`[scenario:setup] sent kickoff to ${WRITER_NAME}`);
}

export const constrainedCommsScenario: EvalScenario = {
  id: 'constrained-comms',
  description:
    'Draft a customer outage notice under hard constraints: a 140-220 word band, three required disclosures, four banned claims, and fact grounding against the seeded brief (with a stale decoy draft planting a wrong duration and banned wording).',
  prompt: [
    `Heads up: ${WRITER_NAME} is drafting the outage notice in the "${PROJECT_NAME}" project.`,
    "You do not need to do anything — just confirm you've seen this note.",
  ].join(' '),
  requiredPromptEvidence: [
    { signal: 'word-band', pattern: /140.{0,3}220 words/ },
    { signal: 'payment-data-disclosure', pattern: /no customer payment data was accessed/ },
    { signal: 'support-contact', pattern: /support@driftwater\.example/ },
    { signal: 'service-credit', pattern: /one-month service credit/ },
    { signal: 'no-guarantee', pattern: /"guarantee"/ },
    { signal: 'grounded-facts', pattern: /38 minutes/ },
  ],
  evidenceTexts: [COMMS_MISSION_OBJECTIVES, COMMS_KICKOFF_MESSAGE],
  timeoutMs: 20 * 60_000,
  progressTimeoutMs: 15 * 60_000,
  setup,
  skipInitialPrompt: true,
  successCheck: async (ctx): Promise<SuccessCheckResult> => {
    const { client, logChanged, recordSniff } = ctx;
    const projectId = await findProjectId(client);
    if (!projectId) {
      logChanged('project', '[scenario] outage-notice project not present yet');
      return { done: false };
    }
    const markdown = await readWorkspaceText(client, projectId, NOTICE_PATH);
    if (markdown === null) {
      logChanged('sniff', `[scenario] ${NOTICE_PATH} not present yet`);
      recordSniff?.({ key: 'constrained-comms', score: 0, bytes: 0 });
      const nearMiss = await findWorkspaceDeliverableNearMiss(client, projectId, NOTICE_PATH);
      await postMissingDeliverableFeedback(ctx, NOTICE_PATH, {
        minPolls: 18,
        repeatEvery: 18,
        maxNudges: 2,
        nearMiss,
        projectId,
      });
      return { done: false };
    }
    const check = checkCustomerNotice(markdown);
    logChanged(
      'sniff',
      `[scenario] constrained-comms bytes=${markdown.length} score=${check.score} signals=${check.signals.join(',') || 'none'}${check.failReason ? ` failReason="${check.failReason}"` : ''}`,
    );
    recordSniff?.({
      key: 'constrained-comms',
      score: check.score,
      bytes: markdown.length,
      ...(check.failReason ? { failReason: check.failReason } : {}),
    });
    if (check.ok) {
      return {
        done: true,
        success: true,
        reason: `notice satisfies the full constraint stack (signals: ${check.signals.join(', ')})`,
      };
    }
    if (check.failReason) {
      await postSniffFeedback(ctx, NOTICE_PATH, check, {
        projectId,
        sourceText: markdown,
        repairDirective: commsRepairDirective(),
      });
    }
    return { done: false };
  },
};
