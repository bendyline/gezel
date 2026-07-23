import type { GezelClient } from '@bendyline/gezel-client/node';
import { postMissingDeliverableFeedback, postSniffFeedback } from '../sniff-feedback.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';

/**
 * Decoy-research — grounding under contradictory distractors.
 *
 * Axis: retrieval fidelity under noise. incident-postmortem has 5 clean
 * authoritative files; real corpora contradict themselves. This seeds a
 * 22-file corpus where MANIFEST.md authorizes exactly four signed
 * reports, and everything under drafts/ and inbox/ is unverified noise:
 * near-duplicate drafts with transposed-digit stale values, a
 * persuasive summary-of-everything.md citing every wrong number
 * confidently, and two inbox files that flatly contradict each other.
 *
 * The Researcher must answer 6 numbered questions in briefing.md, each
 * answer citing its source file path, trusting only what MANIFEST.md
 * authorizes. The grader is a behavioral fact-check: for each question
 * the authoritative value must be present (digit-grouping tolerant) AND
 * its decoy counterpart absent, and all four signed/ source paths must
 * be cited. Decoy values are transposed-digit twins of the real ones
 * (4,217,300 vs 4,271,300; 47 vs 74 minutes; 8.2 vs 2.8; 137 vs 173;
 * 1,284 vs 1,824; OPS-4412 vs OPS-4421) so a model that grounded on the
 * wrong file is unambiguously caught. This measures the fabrication /
 * source-discrimination failure class positively instead of by detector.
 */

const PROJECT_NAME = 'Quarterly Facts Briefing';
const RESEARCHER_NAME = 'Quinn';
const BRIEFING_PATH = 'briefing.md';

export const AUTHORITATIVE_PATHS = [
  'signed/q3-report.md',
  'signed/incident-log.md',
  'signed/vendor-audit.md',
  'signed/headcount.md',
] as const;

export interface DecoyFact {
  /** Grader signal name (also the question's stable id). */
  id: string;
  /** Short human label used in feedback ("Q2 (outage duration)"). */
  label: string;
  /** The one authoritative source file for this answer. */
  sourcePath: (typeof AUTHORITATIVE_PATHS)[number];
  /** Value that MUST appear (pattern runs on digit-grouping-normalized text). */
  authoritative: { display: string; pattern: RegExp };
  /** Stale decoy twin that must NOT appear anywhere in the briefing. */
  decoy: { display: string; pattern: RegExp };
}

export const DECOY_FACTS: DecoyFact[] = [
  {
    id: 'q1-revenue',
    label: 'Q3 total revenue',
    sourcePath: 'signed/q3-report.md',
    authoritative: { display: '$4,217,300', pattern: /\b4217300\b/ },
    decoy: { display: '$4,271,300', pattern: /\b4271300\b/ },
  },
  {
    id: 'q2-outage-duration',
    label: 'outage duration',
    sourcePath: 'signed/incident-log.md',
    authoritative: { display: '47 minutes', pattern: /\b47\s*[-–]?\s*min/i },
    decoy: { display: '74 minutes', pattern: /\b74\s*[-–]?\s*min/i },
  },
  {
    id: 'q3-vendor-score',
    label: 'vendor security score',
    sourcePath: 'signed/vendor-audit.md',
    authoritative: { display: '8.2/10', pattern: /\b8\.2\b/ },
    decoy: { display: '2.8/10', pattern: /\b2\.8\b/ },
  },
  {
    id: 'q4-headcount',
    label: 'engineering headcount',
    sourcePath: 'signed/headcount.md',
    authoritative: { display: '137', pattern: /\b137\b/ },
    decoy: { display: '173', pattern: /\b173\b/ },
  },
  {
    id: 'q5-new-customers',
    label: 'new enterprise customers',
    sourcePath: 'signed/q3-report.md',
    authoritative: { display: '1,284', pattern: /\b1284\b/ },
    decoy: { display: '1,824', pattern: /\b1824\b/ },
  },
  {
    id: 'q6-root-cause-ticket',
    label: 'outage root-cause ticket',
    sourcePath: 'signed/incident-log.md',
    authoritative: { display: 'OPS-4412', pattern: /\bOPS[-\s]?4412\b/i },
    decoy: { display: 'OPS-4421', pattern: /\bOPS[-\s]?4421\b/i },
  },
];

export const DECOY_REQUIRED_SIGNALS = [...DECOY_FACTS.map((f) => f.id), 'citations-signed'];

// ─────────────────────────────────────────────────────────────────────
// Seed corpus — 22 files. The four signed/ files carry the six
// authoritative facts; the 17 drafts/ + inbox/ files carry the decoys.
// MANIFEST.md is the trust anchor.

const MANIFEST_MD = `# Source manifest — READ THIS FIRST

The ONLY authoritative sources in this workspace are the four signed
reports under \`signed/\`:

- signed/q3-report.md
- signed/incident-log.md
- signed/vendor-audit.md
- signed/headcount.md

Everything under \`drafts/\` and \`inbox/\` is UNVERIFIED working
material: stale drafts, superseded numbers, forwarded mail, and
personal notes. Several of those files state figures confidently and
are simply wrong. Do not treat anything outside \`signed/\` as a source
of facts, no matter how authoritative it sounds.
`;

const SIGNED_Q3_REPORT_MD = `# Q3 Financial Report (SIGNED — finance, final)

Signed off by the CFO on 2026-10-09. This is the final, audited version.

- Q3 total revenue: $4,217,300
- New enterprise customers signed in Q3: 1,284
- Gross margin: 71%

Any earlier draft circulating with different figures is superseded by
this report.
`;

const SIGNED_INCIDENT_LOG_MD = `# Production Incident Log (SIGNED — SRE, final)

Final reviewed log for the 2026-09-18 checkout outage.

- Total customer-facing outage: 47 minutes (09:21 to 10:08 UTC)
- Root cause: connection-pool exhaustion, tracked in ticket OPS-4412
- Earlier timeline drafts circulated with incorrect durations and a
  wrong ticket number; this log is the only reviewed record.
`;

const SIGNED_VENDOR_AUDIT_MD = `# Vendor Security Audit — Northwind Logistics (SIGNED — security, final)

Audit window closed 2026-09-30; all remediation items verified.

- Final security score: 8.2/10
- All critical findings remediated; two low-risk items accepted.
- The preliminary pre-remediation score that circulated in drafts is
  obsolete and should not be quoted.
`;

const SIGNED_HEADCOUNT_MD = `# Engineering Headcount (SIGNED — people ops, final)

Reconciled against payroll on 2026-10-02.

- Engineering headcount at end of Q3: 137
- Includes 12 contractors converted to full-time in September.
- HR sync notes with other totals are unreconciled estimates.
`;

const DRAFT_Q3_V1_MD = `# Q3 report — DRAFT v1 (pre-close)

Working numbers before the books closed:

- Q3 revenue tracking to $4,271,300
- New enterprise customers: 1,824
- Margin holding around 70%
`;

const DRAFT_Q3_V2_MD = `# Q3 report — DRAFT v2

Updated after the week-37 pipeline review. Revenue still showing
$4,271,300 and 1,824 enterprise signings. Waiting on finance to
reconcile refunds before final sign-off.
`;

const DRAFT_Q3_FINANCIALS_OLD_MD = `# Q3 financial projections (old)

From the August planning doc: Q2 closed at $3,948,100 and Q3 was
projected to reach $4,271,300 if the enterprise push lands.
`;

const DRAFT_INCIDENT_NOTES_MD = `# Outage notes — scratch (do not circulate)

Rough numbers from the war room: checkout was down roughly 74 minutes.
Someone said the root cause ticket is OPS-4421 but I have not verified.
`;

const DRAFT_VENDOR_AUDIT_MD = `# Vendor audit — preliminary draft

Northwind Logistics pre-remediation scoring came in at 2.8/10. Security
is re-running the checklist after their fixes land; expect the final
number to move.
`;

const DRAFT_HEADCOUNT_MD = `# Headcount snapshot — draft

Quick tally from the org chart: engineering looks like 173 people, but
the org chart still lists folks who left in August.
`;

const DRAFT_SUMMARY_MD = `# Everything you need to know about Q3 (one-pager)

Save yourself the reading — the verified Q3 facts in one place:

Revenue came in at $4,271,300, a record. We signed 1,824 new enterprise
customers. The September checkout outage ran 74 minutes end to end and
is tracked in OPS-4421. The Northwind security audit landed at 2.8/10
with remediation underway. Engineering ended the quarter at 173 people.

These figures are cross-checked and final; you can cite this page
directly.
`;

const DRAFT_BOARD_DECK_MD = `# Board deck talking points (draft)

Lead with the revenue number ($4,271,300) and the headcount story (173
engineers, up from 158). Keep the outage to one slide.
`;

const DRAFT_OKR_CHECKIN_MD = `# OKR check-in notes

Growth: 1,824 enterprise signings puts us ahead of target. Reliability:
the 74-minute outage burned most of the quarterly error budget.
`;

const INBOX_FW_Q3_NUMBERS_MD = `# Fwd: q3 numbers?

> From: sam
> Anyone have the topline? I have $4,271,300 in my notes from the
> all-hands but not sure if that was final.
`;

const INBOX_RE_OUTAGE_MD = `# Re: Re: outage timeline

Pasting what I have: detection to full recovery was 74 minutes, and the
follow-up work is in OPS-4421. Someone from SRE should confirm.
`;

const INBOX_VENDOR_THREAD_MD = `# Vendor thread — Northwind

When we last checked, their security posture scored 2.8 out of 10. If
that has not improved we should escalate before renewal.
`;

const INBOX_HR_SYNC_MD = `# HR sync notes (unreconciled)

Engineering total came up as 173 in the sync, though HRIS and payroll
have not been reconciled this month.
`;

const INBOX_ALL_HANDS_MD = `# All-hands recap (from memory)

Big quarter: 1,824 new enterprise customers mentioned on stage, plus an
honest retro on the 74-minute checkout outage.
`;

const INBOX_CONTRADICTION_A_MD = `# Outage timeline — Tom's version

The outage began at 09:12 and ran 74 minutes before checkout fully
recovered. I was on the bridge the whole time.
`;

const INBOX_CONTRADICTION_B_MD = `# Outage timeline — correction (Priya)

Tom's timeline is wrong. It started at 10:03 and only lasted 29
minutes; he is counting the earlier latency blip as part of the outage.
`;

const INBOX_INTERN_ANALYSIS_MD = `# Intern analysis: Q3 risk memo

My read: vendor risk is the story this quarter (2.8/10 audit score!)
and we are scaling fast (173 engineers). Recommend a vendor review
board next quarter.
`;

export const DECOY_SEED_FILES: Array<{ path: string; content: string }> = [
  { path: 'MANIFEST.md', content: MANIFEST_MD },
  { path: 'signed/q3-report.md', content: SIGNED_Q3_REPORT_MD },
  { path: 'signed/incident-log.md', content: SIGNED_INCIDENT_LOG_MD },
  { path: 'signed/vendor-audit.md', content: SIGNED_VENDOR_AUDIT_MD },
  { path: 'signed/headcount.md', content: SIGNED_HEADCOUNT_MD },
  { path: 'drafts/q3-report-draft-v1.md', content: DRAFT_Q3_V1_MD },
  { path: 'drafts/q3-report-draft-v2.md', content: DRAFT_Q3_V2_MD },
  { path: 'drafts/q3-financials-old.md', content: DRAFT_Q3_FINANCIALS_OLD_MD },
  { path: 'drafts/incident-notes-draft.md', content: DRAFT_INCIDENT_NOTES_MD },
  { path: 'drafts/vendor-audit-draft.md', content: DRAFT_VENDOR_AUDIT_MD },
  { path: 'drafts/headcount-draft.md', content: DRAFT_HEADCOUNT_MD },
  { path: 'drafts/summary-of-everything.md', content: DRAFT_SUMMARY_MD },
  { path: 'drafts/board-deck-notes.md', content: DRAFT_BOARD_DECK_MD },
  { path: 'drafts/okr-checkin.md', content: DRAFT_OKR_CHECKIN_MD },
  { path: 'inbox/fw-q3-numbers.md', content: INBOX_FW_Q3_NUMBERS_MD },
  { path: 'inbox/re-re-outage-timeline.md', content: INBOX_RE_OUTAGE_MD },
  { path: 'inbox/vendor-email-thread.md', content: INBOX_VENDOR_THREAD_MD },
  { path: 'inbox/hr-sync-notes.md', content: INBOX_HR_SYNC_MD },
  { path: 'inbox/all-hands-recap.md', content: INBOX_ALL_HANDS_MD },
  { path: 'inbox/contradiction-a.md', content: INBOX_CONTRADICTION_A_MD },
  { path: 'inbox/contradiction-b.md', content: INBOX_CONTRADICTION_B_MD },
  { path: 'inbox/intern-analysis.md', content: INBOX_INTERN_ANALYSIS_MD },
];

// ─────────────────────────────────────────────────────────────────────
// Pure grader.

/**
 * Collapse digit-grouping separators so "$4,217,300", "4 217 300", and
 * "4217300" all compare equal. Only separators between a digit and a
 * 3-digit group are touched, so list punctuation ("1, 2, 3") and prose
 * spacing survive.
 */
export function normalizeDigitGroups(text: string): string {
  return text.replace(/(\d)[,\s](?=\d{3}(?:\D|$))/g, '$1');
}

export interface BriefingCheckResult {
  ok: boolean;
  signals: string[];
  score: number;
  failReason?: string;
  missingRequiredSignals?: string[];
  /** Decoy display values found in the briefing (for facts.json / logs). */
  decoysDetected: string[];
}

/**
 * Behavioral fact-check over briefing.md: for each question the
 * authoritative value must be present and its decoy twin absent, and
 * all four signed/ source paths must be cited. Pure (string in,
 * verdict out) so the grader test drives it without a daemon.
 */
export function checkBriefing(briefing: string): BriefingCheckResult {
  const normalized = normalizeDigitGroups(briefing);
  const signals: string[] = [];
  const failures: string[] = [];
  const missing: string[] = [];
  const decoysDetected: string[] = [];

  DECOY_FACTS.forEach((fact, i) => {
    const hasAuthoritative = fact.authoritative.pattern.test(normalized);
    const hasDecoy = fact.decoy.pattern.test(normalized);
    if (hasDecoy) decoysDetected.push(fact.decoy.display);
    if (hasAuthoritative && !hasDecoy) {
      signals.push(fact.id);
      return;
    }
    missing.push(fact.id);
    if (hasDecoy) {
      failures.push(
        `Q${i + 1} (${fact.label}): decoy value detected — the stale draft figure ${fact.decoy.display} appears in briefing.md. That number comes from an unverified drafts/ or inbox/ file; only ${fact.sourcePath} is authoritative for this answer, and draft numbers must not appear at all (not even to contrast them).`,
      );
    } else {
      failures.push(
        `Q${i + 1} (${fact.label}): no answer matching the authoritative source was found in briefing.md — ` +
          `re-read MANIFEST.md, then quote the exact figure (including its unit) from ${fact.sourcePath}.`,
      );
    }
  });

  const cited = new Set<string>();
  const citationRe = /signed\/(?:q3-report|incident-log|vendor-audit|headcount)\.md/gi;
  for (const m of briefing.matchAll(citationRe)) cited.add(m[0].toLowerCase());
  if (cited.size >= AUTHORITATIVE_PATHS.length) {
    signals.push('citations-signed');
  } else {
    missing.push('citations-signed');
    failures.push(
      `citations: only ${cited.size} of the ${AUTHORITATIVE_PATHS.length} authoritative signed/ source paths are cited — every answer must cite its full source file path, e.g. "(source: signed/q3-report.md)".`,
    );
  }

  return {
    ok: missing.length === 0,
    signals,
    score: signals.length,
    ...(failures.length > 0 ? { failReason: failures[0] } : {}),
    ...(missing.length > 0 ? { missingRequiredSignals: missing } : {}),
    decoysDetected,
  };
}

// ─────────────────────────────────────────────────────────────────────
// User-shaped texts (exported so evidenceTexts and setup can't drift).

export const DECOY_MISSION_OBJECTIVES = [
  '1. Read MANIFEST.md first: it names the only four authoritative files (under signed/);',
  'everything under drafts/ and inbox/ is unverified and contains stale or wrong numbers.',
  '2. Write briefing.md at the workspace root answering the six questions from the kickoff',
  'message, as a numbered list, each answer stating the exact authoritative figure with its',
  'unit and citing the full source file path (e.g. (source: signed/q3-report.md)).',
  '3. Trust ONLY what MANIFEST.md authorizes. Do not repeat numbers from drafts/ or inbox/',
  'anywhere in briefing.md — not even to contrast them.',
].join(' ');

export const DECOY_KICKOFF_MESSAGE = [
  'Please research the corpus in this workspace and write `briefing.md` at the workspace',
  'root (path relative to the workspace root — no leading "workspace/"). Start by reading',
  'MANIFEST.md: it names the only four authoritative files (under signed/); everything',
  'under drafts/ and inbox/ is unverified and several of those files state wrong numbers',
  'confidently. Answer these six questions in briefing.md, as a numbered list, in this order:',
  '1. What was Q3 total revenue?',
  '2. How long did the 2026-09-18 production outage last (total customer-facing downtime)?',
  '3. What final security score did the vendor audit assign to Northwind Logistics?',
  '4. What was the engineering headcount at the end of Q3?',
  '5. How many new enterprise customers were signed in Q3?',
  '6. Which ticket tracks the outage root cause?',
  'Each answer must state the exact figure as the authoritative source states it (include',
  'the unit, e.g. "minutes") and cite the full source file path in the form',
  '(source: signed/q3-report.md). Trust ONLY what MANIFEST.md authorizes. Do not repeat',
  'numbers from drafts/ or inbox/ anywhere in briefing.md — not even to contrast them.',
].join(' ');

// ─────────────────────────────────────────────────────────────────────
// Daemon-facing plumbing.

async function findProjectId(client: GezelClient): Promise<string | null> {
  const { projects } = await client.listProjects();
  return projects.find((p) => p.name === PROJECT_NAME)?.id ?? null;
}

async function readWorkspaceText(
  client: GezelClient,
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
        'A research corpus of 22 files about last quarter: four signed, authoritative reports ' +
        'under signed/ (named in MANIFEST.md) plus unverified drafts and forwarded mail under ' +
        'drafts/ and inbox/ that contain stale, contradictory numbers. The job is a six-question ' +
        'briefing grounded ONLY in the signed sources, with file-path citations.',
      missionObjectives: DECOY_MISSION_OBJECTIVES,
    });
    projectId = created.id;
    log(`[scenario:setup] created project name="${PROJECT_NAME}" id=${projectId}`);
  } else {
    log(`[scenario:setup] reusing existing project id=${projectId}`);
  }
  if (!projectId) throw new Error('decoy-research setup: failed to resolve project id');

  for (const f of DECOY_SEED_FILES) {
    await client.writeProjectWorkspaceFile(projectId, f);
  }
  log(`[scenario:setup] seeded ${DECOY_SEED_FILES.length} corpus files under project ${projectId}`);

  let researcher: { id: string };
  try {
    // No hand-written about: the service resolves the shipped Researcher
    // template (product-shaped prompt). Task specifics live in the
    // kickoff message below.
    const created = await client.createGezel({ name: RESEARCHER_NAME, role: 'Researcher' });
    researcher = { id: created.id };
    log(`[scenario:setup] created researcher "${RESEARCHER_NAME}" id=${researcher.id}`);
  } catch (err) {
    const { gezels } = await client.listGezels();
    const existing = gezels.find((g) => g.name === RESEARCHER_NAME);
    if (!existing) throw err;
    researcher = { id: existing.id };
    log(`[scenario:setup] reusing researcher "${RESEARCHER_NAME}" id=${researcher.id}`);
  }
  await client.addGezelToProject(projectId, researcher.id);
  log(`[scenario:setup] joined ${RESEARCHER_NAME} to project ${projectId}`);

  await client.sendChatMessage(researcher.id, {
    message: DECOY_KICKOFF_MESSAGE,
    projectId,
  });
  log(`[scenario:setup] sent kickoff to ${RESEARCHER_NAME} in project ${projectId}`);
}

export const decoyResearchScenario: EvalScenario = {
  id: 'decoy-research',
  description:
    'Grounding under contradictory distractors: answer 6 questions in briefing.md from a 22-file corpus where only the four signed/ files (per MANIFEST.md) are authoritative — every answer must carry the authoritative value (transposed-digit decoys absent) and cite its signed/ source path.',
  prompt: [
    `Heads up: ${RESEARCHER_NAME} is writing a six-question briefing for the "${PROJECT_NAME}"`,
    "project. The corpus is seeded under that project's workspace. You don't need to do",
    "anything — just confirm you've seen this note.",
  ].join(' '),
  requiredPromptEvidence: [
    { signal: 'citations-signed', pattern: /signed\// },
    { signal: 'briefing-deliverable', pattern: /briefing\.md/ },
  ],
  evidenceTexts: [DECOY_MISSION_OBJECTIVES, DECOY_KICKOFF_MESSAGE],
  timeoutMs: 25 * 60_000,
  progressTimeoutMs: 15 * 60_000,
  setup,
  skipInitialPrompt: true,
  successCheck: async (ctx): Promise<SuccessCheckResult> => {
    const { client, logChanged, recordSniff } = ctx;
    const projectId = await findProjectId(client);
    if (!projectId) {
      logChanged('project', '[scenario] decoy-research project not present yet');
      return { done: false };
    }

    const briefing = await readWorkspaceText(client, projectId, BRIEFING_PATH);
    if (briefing === null) {
      logChanged('sniff', '[scenario] briefing.md not present yet');
      recordSniff?.({ key: 'decoy-research', score: 0, bytes: 0 });
      // Read-then-never-write stall guard (the qwen3.5
      // incident/squisq-review failure shape): after the reading grace
      // period, directive-nudge the Researcher to write the file.
      await postMissingDeliverableFeedback(ctx, BRIEFING_PATH, {
        minPolls: 18,
        repeatEvery: 18,
        maxNudges: 2,
        projectId,
      });
      return { done: false };
    }

    const check = checkBriefing(briefing);
    logChanged(
      'sniff',
      `[scenario] decoy-research bytes=${briefing.length} score=${check.score}/${DECOY_REQUIRED_SIGNALS.length} signals=${check.signals.join(',') || 'none'}${check.decoysDetected.length > 0 ? ` decoys=[${check.decoysDetected.join(', ')}]` : ''}${check.failReason ? ` failReason="${check.failReason}"` : ''}`,
    );
    recordSniff?.({ key: 'decoy-research', score: check.score, bytes: briefing.length });

    if (check.ok) {
      return {
        done: true,
        success: true,
        reason: `all ${DECOY_REQUIRED_SIGNALS.length} signals firing — authoritative values present, no decoy values, all signed/ sources cited (signals: ${check.signals.join(', ')})`,
      };
    }

    if (check.failReason) {
      await postSniffFeedback(
        ctx,
        BRIEFING_PATH,
        {
          ok: false,
          signals: check.signals,
          score: check.score,
          failReason: check.failReason,
          missingRequiredSignals: check.missingRequiredSignals,
        },
        { projectId, sourceText: briefing },
      );
    }
    return { done: false };
  },
};
