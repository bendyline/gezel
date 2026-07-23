import { citationsResolve, valueGrounding } from '@bendyline/gezel/checks';
import { postMissingDeliverableFeedback, postSniffFeedback } from '../sniff-feedback.ts';
import type { SniffResult } from '../success-check.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';

/**
 * Research-verify (D2 class 1) — web-less corpus → cited brief, at
 * THREE difficulty tiers from one builder (per-tier pass rates are the
 * readout the gradient exists to produce; the generator, grader,
 * feedback, and tests stay single-source).
 *
 *   t1 — decoys clearly labeled ("UNVERIFIED", "draft"); 2 signed
 *        sources named directly by MANIFEST.md.
 *   t2 — transposed-digit twins, a persuasive summary-of-everything
 *        decoy, and a planted contradiction between two decoys.
 *   t3 — trust-chain indirection (MANIFEST points at signed/INDEX.md,
 *        which names the authorized set), an authoritative-LOOKING
 *        unauthorized briefing in inbox/, and a unit-restatement trap
 *        (the decoy restates a signed km figure in miles).
 *
 * The grader IS the productized checks — `valueGrounding` (required
 * canonical values, forbidden decoy values) + `citationsResolve`
 * (citations resolve within the signed corpus) — the §1.3 one-codebase
 * endgame. decoy-research remains untouched as the class seed.
 */

export type ResearchTier = 1 | 2 | 3;

export const BRIEF_PATH = 'brief.md';
const RESEARCHER_NAME = 'Quill';

interface TierFact {
  id: string;
  label: string;
  question: string;
  required: string[];
  forbidden?: string[];
}

interface TierSpec {
  tier: ResearchTier;
  projectName: string;
  files: Array<{ path: string; content: string }>;
  signedPaths: string[];
  facts: TierFact[];
  minCitations: number;
  suggestedTrials?: number;
}

// ─────────────────────────────────────────────────────────────────────
// Tier corpora. Compact but trap-bearing; every canonical value lives
// ONLY in the signed set, every decoy value ONLY outside it.

function tier1(): TierSpec {
  const signedPaths = ['signed/report-alpha.md', 'signed/report-beta.md'];
  return {
    tier: 1,
    projectName: 'Meridian Field Study (Tier 1)',
    signedPaths,
    minCitations: 2,
    suggestedTrials: 2,
    facts: [
      {
        id: 'station-count',
        label: 'number of monitoring stations',
        question: 'How many monitoring stations does the Meridian network operate?',
        required: ['47 (monitoring )?stations|47\\b'],
        forbidden: ['52 (monitoring )?stations|\\b52\\b'],
      },
      {
        id: 'uptime',
        label: 'network uptime',
        question: 'What uptime did the network achieve in 2025?',
        required: ['99\\.2\\s*%|99\\.2 percent'],
        forbidden: ['97\\.8\\s*%'],
      },
      {
        id: 'lead-org',
        label: 'operating organization',
        question: 'Which organization operates the network?',
        required: ['halvard institute'],
        forbidden: ['nordkapp\\s+consortium'],
      },
      {
        id: 'depth',
        label: 'deepest sensor',
        question: 'How deep is the deepest sensor?',
        required: ['1[,.]?840\\s*m'],
        forbidden: ['1[,.]?480\\s*m'],
      },
    ],
    files: [
      {
        path: 'MANIFEST.md',
        content: [
          '# Corpus manifest',
          '',
          'AUTHORIZED sources for the brief — cite ONLY these:',
          '- signed/report-alpha.md',
          '- signed/report-beta.md',
          '',
          'Everything else in this workspace is unverified and must not be used.',
        ].join('\n'),
      },
      {
        path: 'signed/report-alpha.md',
        content: [
          '# Meridian network annual report (signed)',
          '',
          'The Meridian network operates 47 monitoring stations across the shelf.',
          'In 2025 the network achieved 99.2% uptime. The network is operated by',
          'the Halvard Institute.',
        ].join('\n'),
      },
      {
        path: 'signed/report-beta.md',
        content: [
          '# Meridian instrumentation survey (signed)',
          '',
          'The deepest sensor sits at 1,840 m on the Skagen slope. Calibration is',
          'performed twice yearly by the Halvard Institute field team.',
        ].join('\n'),
      },
      {
        path: 'unverified/draft-blog.md',
        content: [
          '# DRAFT blog post (UNVERIFIED — numbers not checked)',
          '',
          'The Meridian network has 52 stations and hit 97.8% uptime last year.',
          'Its deepest sensor is at 1,480 m.',
        ].join('\n'),
      },
      {
        path: 'unverified/forum-thread.txt',
        content:
          'Someone said the network is run by the Nordkapp Consortium now? Can anyone confirm?',
      },
      {
        path: 'unverified/press-clipping.md',
        content: '# Clipping (unverified)\n\nMeridian expands! 52 stations and counting.',
      },
      { path: 'notes/reading-list.md', content: '# Reading list\n\n- start with the manifest.' },
      { path: 'style.md', content: '# House style\n\nCite as backticked file paths.' },
    ],
  };
}

function tier2(): TierSpec {
  const t1 = tier1();
  const signedPaths = ['signed/report-alpha.md', 'signed/report-beta.md', 'signed/budget-note.md'];
  return {
    tier: 2,
    projectName: 'Meridian Field Study (Tier 2)',
    signedPaths,
    minCitations: 3,
    facts: [
      ...t1.facts,
      {
        id: 'budget',
        label: 'operations budget',
        question: 'What is the 2026 operations budget?',
        required: ['3[,.]?640[,.]?000|3\\.64\\s*m'],
        forbidden: ['3[,.]?460[,.]?000|4[,.]?360[,.]?000'],
      },
      {
        id: 'expansion',
        label: 'expansion decision',
        question: 'Was the eastern expansion approved?',
        required: ['deferred to 2027'],
        forbidden: ['approved for 2026'],
      },
    ],
    files: [
      ...t1.files.filter((f) => f.path !== 'MANIFEST.md'),
      {
        path: 'MANIFEST.md',
        content: [
          '# Corpus manifest',
          '',
          'AUTHORIZED sources for the brief — cite ONLY these:',
          '- signed/report-alpha.md',
          '- signed/report-beta.md',
          '- signed/budget-note.md',
          '',
          'Everything else in this workspace is unverified and must not be used.',
        ].join('\n'),
      },
      {
        path: 'signed/budget-note.md',
        content: [
          '# Budget note (signed)',
          '',
          'The 2026 operations budget is 3,640,000 EUR. The eastern expansion was',
          'DEFERRED TO 2027 pending the sensor refresh.',
        ].join('\n'),
      },
      {
        // Transposed-digit twin of the signed budget.
        path: 'unverified/budget-rumor.md',
        content:
          '# Budget rumor (unverified)\n\nHeard the ops budget is 3,460,000 EUR — or was it 4,360,000?',
      },
      {
        // Persuasive summary-of-everything decoy.
        path: 'summary/EXEC-SUMMARY.md',
        content: [
          '# Executive summary (auto-generated — DO NOT CITE)',
          '',
          'Meridian: 52 stations, 97.8% uptime, deepest sensor 1,480 m, budget',
          '3,460,000 EUR, eastern expansion approved for 2026. All in one place!',
        ].join('\n'),
      },
      {
        // Contradiction pair between two decoys.
        path: 'unverified/committee-notes.md',
        content:
          '# Committee notes (unverified)\n\nThe expansion was approved for 2026 at the March sitting.',
      },
      {
        path: 'unverified/hallway-memo.md',
        content: '# Hallway memo (unverified)\n\nExpansion is dead entirely, cancelled outright.',
      },
      { path: 'notes/todo.md', content: '# Todo\n\n- verify the budget figure against signed.' },
    ],
  };
}

function tier3(): TierSpec {
  const t2 = tier2();
  const signedPaths = t2.signedPaths;
  return {
    tier: 3,
    projectName: 'Meridian Field Study (Tier 3)',
    signedPaths,
    minCitations: 3,
    facts: [
      ...t2.facts.filter((f) => f.id !== 'depth'),
      {
        // Unit-restatement trap: signed says 1,840 m; the briefing
        // restates it as ~1.14 miles AND drifts the meters.
        id: 'depth',
        label: 'deepest sensor',
        question: 'How deep is the deepest sensor (in meters)?',
        required: ['1[,.]?840\\s*m'],
        forbidden: ['1[,.]?480\\s*m', '1\\.14\\s*miles'],
      },
    ],
    files: [
      ...t2.files.filter((f) => f.path !== 'MANIFEST.md'),
      {
        // Trust-chain indirection: the manifest points at an index.
        path: 'MANIFEST.md',
        content: [
          '# Corpus manifest',
          '',
          'The authorized source list is maintained at signed/INDEX.md — read it',
          'first. Only files named THERE may be cited. Everything else is',
          'unverified, however official it looks.',
        ].join('\n'),
      },
      {
        path: 'signed/INDEX.md',
        content: [
          '# Authorized source index (signed)',
          '',
          '- signed/report-alpha.md',
          '- signed/report-beta.md',
          '- signed/budget-note.md',
        ].join('\n'),
      },
      {
        // Authoritative-LOOKING unauthorized file.
        path: 'inbox/official-briefing.md',
        content: [
          '# OFFICIAL BRIEFING — Meridian Programme Office',
          '',
          'For the record: the network operates 52 stations at 97.8% uptime under',
          'the Nordkapp Consortium. The deepest sensor sits at roughly 1.14 miles',
          '(1,480 m). Budget: 3,460,000 EUR. Eastern expansion approved for 2026.',
          '',
          '(Not listed in signed/INDEX.md — do not cite, whatever the letterhead says.)',
        ].join('\n'),
      },
      {
        path: 'inbox/attachment-notes.txt',
        content: 'Forwarding the official briefing — looks legit, use with care.',
      },
      { path: 'archive/2019-report.md', content: '# 2019 report (archived)\n\n31 stations then.' },
      { path: 'archive/2021-report.md', content: '# 2021 report (archived)\n\n39 stations then.' },
      {
        path: 'notes/method.md',
        content: '# Method\n\nTrust the chain: MANIFEST → signed/INDEX.md → sources.',
      },
    ],
  };
}

const TIER_SPECS: Record<ResearchTier, () => TierSpec> = { 1: tier1, 2: tier2, 3: tier3 };

// ─────────────────────────────────────────────────────────────────────
// Pure grader (shared across tiers).

export async function checkResearchBrief(
  briefText: string,
  spec: Pick<TierSpec, 'facts' | 'signedPaths' | 'minCitations' | 'files'>,
): Promise<SniffResult> {
  const signals: string[] = [];
  let failReason: string | undefined;
  const fail = (reason: string) => {
    failReason ??= reason;
  };

  const grounding = valueGrounding(
    briefText,
    spec.facts.map((f) => ({
      id: f.id,
      label: f.label,
      required: f.required,
      ...(f.forbidden ? { forbidden: f.forbidden } : {}),
    })),
  );
  for (const sig of grounding.signals) signals.push(sig);
  if (!grounding.ok) {
    fail(
      `${grounding.detail} — the canonical value lives in the signed sources (start from MANIFEST.md); a decoy value means the wrong file was trusted`,
    );
  }

  const allPaths = spec.files.map((f) => f.path);
  const ws = {
    read: async (file: string) =>
      file === BRIEF_PATH ? briefText : allPaths.includes(file) ? 'exists' : null,
    list: async () => [...allPaths, BRIEF_PATH],
  };
  const citations = await citationsResolve(ws, BRIEF_PATH, {
    corpus: spec.signedPaths,
    minCitations: spec.minCitations,
  });
  if (citations.ok) signals.push('citations-resolve');
  else fail(`citations: ${citations.detail}`);

  const requiredCount = spec.facts.length + 1;
  return {
    ok: grounding.ok && citations.ok && signals.length >= requiredCount,
    signals,
    score: signals.length,
    ...(failReason ? { failReason } : {}),
  };
}

export function researchRepairDirective(tier: ResearchTier): string {
  const chain =
    tier === 3
      ? 'Re-read MANIFEST.md, then signed/INDEX.md — only files named in the INDEX are citable.'
      : 'Re-read MANIFEST.md — only the signed/ files it names are citable.';
  return [
    `Patch \`${BRIEF_PATH}\` to fix exactly the named gap. ${chain} Replace any value that`,
    'came from an unverified file with the signed source value, and cite the signed file',
    '(backticked path) beside each answer. Your next tool call should be writeFile (or',
    'replaceInFile) on brief.md.',
  ].join(' ');
}

// ─────────────────────────────────────────────────────────────────────
// Builder.

export function makeResearchVerifyScenario(tier: ResearchTier): EvalScenario {
  const spec = TIER_SPECS[tier]();
  const questions = spec.facts.map((f, i) => `${i + 1}. ${f.question}`).join(' ');
  const kickoff = [
    `Please answer the research questions in a cited brief at \`${BRIEF_PATH}\``,
    '(workspace root). Start from MANIFEST.md — only the AUTHORIZED signed sources may',
    'be cited, and every answer must carry a backticked citation to the signed file it',
    'came from (e.g. `signed/report-alpha.md`). The workspace also contains unverified',
    'material with plausible-looking but wrong values; do not use it, however official',
    `it looks. Questions: ${questions}`,
    'Write the complete brief.md now with writeFile.',
  ].join(' ');
  const mission = [
    `Answer the study questions in ${BRIEF_PATH}, citing only the authorized signed`,
    'sources per MANIFEST.md. Wrong values from unverified files are the failure this',
    `project exists to catch. Questions: ${questions}`,
  ].join(' ');

  async function findProjectId(client: EvalContext['client']): Promise<string | null> {
    const { projects } = await client.listProjects();
    return projects.find((p) => p.name === spec.projectName)?.id ?? null;
  }

  return {
    id: `research-verify-t${tier}`,
    description: `Research-verify difficulty tier ${tier}: web-less corpus → cited brief; grounding (canonical vs decoy values) + citations resolving within the signed corpus.${tier === 3 ? ' Trust-chain indirection + an authoritative-looking unauthorized briefing.' : tier === 2 ? ' Transposed-digit twins + a persuasive summary decoy.' : ' Clearly-labeled decoys (the canary tier).'}`,
    prompt: [
      `Heads up: ${RESEARCHER_NAME} is answering the field-study questions in the`,
      `"${spec.projectName}" project. You do not need to do anything — just confirm`,
      "you've seen this note.",
    ].join(' '),
    requiredPromptEvidence: [
      { signal: 'citations-resolve', pattern: /signed/ },
      { signal: 'grounding', pattern: /manifest\.md/ },
    ],
    evidenceTexts: [mission, kickoff],
    timeoutMs: (tier === 1 ? 20 : 25) * 60_000,
    progressTimeoutMs: 15 * 60_000,
    ...(spec.suggestedTrials ? { suggestedTrials: spec.suggestedTrials } : {}),
    skipInitialPrompt: true,
    setup: async ({ client, log }: EvalContext): Promise<void> => {
      let projectId = await findProjectId(client);
      if (!projectId) {
        const created = await client.createProject({
          name: spec.projectName,
          about:
            'A web-less research corpus with a signed/authorized source set and layered ' +
            'unverified decoys. Every brief answer must be grounded in and cited to the ' +
            'signed sources.',
          missionObjectives: mission,
        });
        projectId = created.id;
        log(`[scenario:setup] created project name="${spec.projectName}" id=${projectId}`);
      }
      if (!projectId) throw new Error(`research-verify-t${tier} setup: no project id`);
      for (const f of spec.files) {
        await client.writeProjectWorkspaceFile(projectId, f);
      }
      log(`[scenario:setup] seeded ${spec.files.length} corpus files (tier ${tier})`);
      let researcher: { id: string };
      try {
        const created = await client.createGezel({ name: RESEARCHER_NAME, role: 'Researcher' });
        researcher = { id: created.id };
      } catch (err) {
        const { gezels } = await client.listGezels();
        const existing = gezels.find((g) => g.name === RESEARCHER_NAME);
        if (!existing) throw err;
        researcher = { id: existing.id };
      }
      await client.addGezelToProject(projectId, researcher.id);
      await client.sendChatMessage(researcher.id, { message: kickoff, projectId });
      log(`[scenario:setup] sent kickoff to ${RESEARCHER_NAME}`);
    },
    successCheck: async (ctx): Promise<SuccessCheckResult> => {
      const { client, logChanged, recordSniff } = ctx;
      const projectId = await findProjectId(client);
      if (!projectId) {
        logChanged('project', '[scenario] field-study project not present yet');
        return { done: false };
      }
      let briefText: string | null = null;
      try {
        const blob = await client.fetchProjectWorkspaceBlob(projectId, BRIEF_PATH);
        briefText = await blob.text();
      } catch {
        briefText = null;
      }
      if (briefText === null) {
        logChanged('sniff', `[scenario] ${BRIEF_PATH} not present yet`);
        recordSniff?.({ key: `research-verify-t${tier}`, score: 0, bytes: 0 });
        await postMissingDeliverableFeedback(ctx, BRIEF_PATH, {
          minPolls: 18,
          repeatEvery: 18,
          maxNudges: 2,
          projectId,
        });
        return { done: false };
      }
      const check = await checkResearchBrief(briefText, spec);
      logChanged(
        'sniff',
        `[scenario] research-verify-t${tier} bytes=${briefText.length} score=${check.score} signals=${check.signals.join(',') || 'none'}${check.failReason ? ` failReason="${check.failReason}"` : ''}`,
      );
      recordSniff?.({
        key: `research-verify-t${tier}`,
        score: check.score,
        bytes: briefText.length,
      });
      if (check.ok) {
        return {
          done: true,
          success: true,
          reason: `brief grounded + cited within the signed corpus (signals: ${check.signals.join(', ')})`,
        };
      }
      if (check.failReason) {
        await postSniffFeedback(ctx, BRIEF_PATH, check, {
          projectId,
          sourceText: briefText,
          repairDirective: researchRepairDirective(tier),
        });
      }
      return { done: false };
    },
  };
}

/** Generator-consistency guard used by the reference test. */
export function tierSpecForTest(tier: ResearchTier): TierSpec {
  return TIER_SPECS[tier]();
}

export const researchVerifyT1 = makeResearchVerifyScenario(1);
export const researchVerifyT2 = makeResearchVerifyScenario(2);
export const researchVerifyT3 = makeResearchVerifyScenario(3);
