/**
 * Level-up proposal generation. Trait proposals come from the Klerk
 * analyzing the gezel's recent kind-tagged memories for PROVEN trends;
 * every evidence line is validated against the real corpus (exact or
 * long-substring match, with day/kind rewritten from the matched entry)
 * so a fabricated quote can never reach the user. Tuning and cosmetic
 * payout options are deterministic and server-built — when no trend is
 * strong enough (or the Klerk is unavailable) the level-up degrades to
 * payout-only rather than fabricating traits.
 */

import { randomUUID } from 'node:crypto';
import {
  type CosmeticProposal,
  DEFAULT_TUNING_PROFILE_ID,
  type GezelFrontmatter,
  type GezelGrowthState,
  type GrowthEvidence,
  type GrowthProposal,
  type KnownProfileId,
  type TraitProposal,
  type TuningProposal,
  createLogger,
  isKnownProfileId,
  nextLockedCosmetic,
} from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import type { CompactOneShot } from '../memory/compaction.js';
import { type MemoryKind, isMemoryKind } from '../memory/daily-markdown.js';
import type { MemoryManager } from '../memory/manager.js';

const log = createLogger('growth');

/** How far back the trait analysis looks. */
const PROPOSAL_LOOKBACK_DAYS = 45;
/** Char budget for the memory entries handed to the Klerk (newest first). */
const PROPOSAL_INPUT_BUDGET = 14_000;
/** Minimum normalized length for a substring evidence match. */
const MIN_EVIDENCE_SUBSTRING = 24;
/** Hard cap on traits offered per level-up. */
const MAX_TRAIT_PROPOSALS = 2;

const PROPOSAL_PROMPT = `You are analyzing an AI agent's accumulated memories to find PROVEN behavioral trends worth promoting into permanent traits. A trait is one imperative sentence that will be added to the agent's standing instructions — it must describe a way of working that the memories show has ALREADY been happening and working well, not an aspiration.

Rules:
- Propose at most 3 traits. Fewer is better. Zero is a perfectly good answer.
- Each trait must be grounded in at least 2 separate memory entries showing the same trend (a preference applied repeatedly, a practice that produced good outcomes, a recurring decision pattern).
- Evidence lines must QUOTE the memory entries VERBATIM, character for character, including their dates. Never paraphrase, never invent. A proposal with fabricated evidence will be discarded.
- The trait line is ONE imperative sentence, max 160 characters, second person, concrete (e.g. "Write failing tests before touching implementation code."). No vague virtues ("be helpful", "communicate clearly").
- Do NOT propose anything matching the ALREADY ADOPTED or PREVIOUSLY DECLINED lists below, or a close rephrasing of them.
- Do NOT propose project-specific behavior (file paths, repository or project names, a single project's conventions). Traits travel across all projects.

Output format — repeat this block for each proposal, nothing else, no commentary:
PROPOSAL
TITLE: <max 8 words>
TRAIT: <one imperative sentence>
EVIDENCE: <YYYY-MM-DD> :: <verbatim memory entry text>
EVIDENCE: <YYYY-MM-DD> :: <verbatim memory entry text>
END

If no trend is strong enough, respond with exactly: NONE.
`;

export interface CorpusEntry {
  day: string;
  kind: MemoryKind;
  text: string;
}

export interface TraitProposalDraft {
  title: string;
  traitText: string;
  evidence: GrowthEvidence[];
}

const TITLE_RE = /^TITLE:\s*(.+)$/;
const TRAIT_RE = /^TRAIT:\s*(.+)$/;
const EVIDENCE_RE = /^EVIDENCE:\s*(\d{4}-\d{2}-\d{2})\s*::\s*(.+)$/;

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Parse + evidence-validate raw Klerk output. The anti-hallucination
 * wall: an evidence line survives only when its text exact-matches a
 * real corpus entry or is a ≥24-char substring of one (whitespace-
 * normalized) — and on match, the day/kind/excerpt are REWRITTEN from
 * the matched entry, so the model cannot mint dates or text. Proposals
 * with zero surviving evidence are dropped.
 */
export function parseProposalOutput(
  raw: string,
  corpus: ReadonlyArray<CorpusEntry>,
): TraitProposalDraft[] {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'NONE') return [];

  const normalizedCorpus = corpus.map((e) => ({ entry: e, norm: normalize(e.text) }));
  const drafts: TraitProposalDraft[] = [];
  let current: { title?: string; traitText?: string; evidence: GrowthEvidence[] } | null = null;

  const flush = () => {
    if (current?.title && current.traitText && current.evidence.length > 0) {
      drafts.push({
        title: current.title.slice(0, 80),
        traitText: current.traitText,
        evidence: current.evidence.slice(0, 3),
      });
    }
    current = null;
  };

  for (const rawLine of trimmed.split('\n')) {
    const line = rawLine.replace(/^[-*]\s+/, '').trim();
    if (!line) continue;
    if (line === 'PROPOSAL') {
      flush();
      current = { evidence: [] };
      continue;
    }
    if (line === 'END') {
      flush();
      continue;
    }
    if (!current) continue;
    const title = line.match(TITLE_RE);
    if (title) {
      current.title = title[1]!.trim();
      continue;
    }
    const trait = line.match(TRAIT_RE);
    if (trait) {
      const text = trait[1]!.trim();
      // Hard-reject overlong traits rather than truncate — a truncated
      // imperative is broken.
      if (text.length <= 200) current.traitText = text;
      continue;
    }
    const evidence = line.match(EVIDENCE_RE);
    if (evidence) {
      const quoted = normalize(evidence[2]!);
      const match = normalizedCorpus.find(
        (c) =>
          c.norm === quoted || (quoted.length >= MIN_EVIDENCE_SUBSTRING && c.norm.includes(quoted)),
      );
      if (match) {
        current.evidence.push({
          day: match.entry.day,
          kind: match.entry.kind,
          excerpt: match.entry.text.slice(0, 400),
        });
      }
    }
  }
  flush();

  // Strongest first = most surviving evidence.
  return drafts.sort((a, b) => b.evidence.length - a.evidence.length);
}

/**
 * Fixed profile-switch adjacency: every canonical profile has one
 * "interesting next step". Deterministic — no LLM, no randomness.
 */
const PROFILE_ADJACENCY: Record<KnownProfileId, KnownProfileId> = {
  'thinking-general': 'thinking-coding',
  'thinking-deep': 'thinking-general',
  'thinking-coding': 'thinking-precise',
  'thinking-precise': 'thinking-general',
  instruct: 'thinking-general',
  creative: 'thinking-general',
  terse: 'instruct',
  deterministic: 'instruct',
};

/**
 * Deterministic non-trait payout options: one tuning nudge (even levels
 * switch profile via the adjacency table; odd levels nudge temperature
 * ±0.1, clamped at accept time) and one cosmetic (the next locked
 * catalog entry, else a generic milestone marker) — the cosmetic is the
 * guaranteed-resolvable fallback every level-up carries.
 */
export function buildPayoutOptions(
  frontmatter: Pick<GezelFrontmatter, 'tuningProfile' | 'suggestedTuningProfile'>,
  toLevel: number,
  unlockedCosmeticIds: ReadonlySet<string>,
): GrowthProposal[] {
  const options: GrowthProposal[] = [];

  if (toLevel % 2 === 0) {
    const currentRaw =
      frontmatter.tuningProfile ?? frontmatter.suggestedTuningProfile ?? DEFAULT_TUNING_PROFILE_ID;
    const current = isKnownProfileId(currentRaw) ? currentRaw : DEFAULT_TUNING_PROFILE_ID;
    const next = PROFILE_ADJACENCY[current];
    const tuning: TuningProposal = {
      id: `prop-${randomUUID().slice(0, 8)}`,
      kind: 'tuning',
      title: `Switch tuning to ${next}`,
      description: `Move from the ${current} preset to ${next}. Bounded change — only the sampling preset moves; switch back any time in settings.`,
      action: { type: 'profile', profile: next },
    };
    options.push(tuning);
  } else {
    const tighter = toLevel % 4 === 3;
    const tuning: TuningProposal = {
      id: `prop-${randomUUID().slice(0, 8)}`,
      kind: 'tuning',
      title: tighter ? 'Tighter, more deliberate' : 'Looser, more exploratory',
      description: tighter
        ? 'Nudge temperature down 0.1 (clamped to ±20% of current) — more deterministic, more focused.'
        : 'Nudge temperature up 0.1 (clamped to ±20% of current) — more varied, more exploratory.',
      action: { type: 'temperature', delta: tighter ? -0.1 : 0.1 },
    };
    options.push(tuning);
  }

  const cosmetic = nextLockedCosmetic(toLevel, unlockedCosmeticIds);
  const cosmeticOption: CosmeticProposal = cosmetic
    ? {
        id: `prop-${randomUUID().slice(0, 8)}`,
        kind: 'cosmetic',
        title: `Unlock the ${cosmetic.label.toLowerCase()}`,
        cosmeticId: cosmetic.id,
      }
    : {
        id: `prop-${randomUUID().slice(0, 8)}`,
        kind: 'cosmetic',
        title: `Mark the level ${toLevel} milestone`,
        cosmeticId: `level-${toLevel}`,
      };
  options.push(cosmeticOption);

  return options;
}

export interface ProposalGenArgs {
  store: Store;
  memory: MemoryManager;
  oneShot: CompactOneShot;
  gezelId: string;
  toLevel: number;
  state: GezelGrowthState;
  frontmatter: Pick<GezelFrontmatter, 'tuningProfile' | 'suggestedTuningProfile'>;
  /** When false, skip the Klerk call entirely (payout options only). */
  allowKlerk: boolean;
}

/** Build the full 2–4 proposal set for a pending level-up. */
export async function generateProposals(args: ProposalGenArgs): Promise<GrowthProposal[]> {
  const { gezelId, toLevel, state } = args;

  const traits: GrowthProposal[] = [];
  if (args.allowKlerk) {
    try {
      const drafts = await generateTraitDrafts(args);
      for (const d of drafts.slice(0, MAX_TRAIT_PROPOSALS)) {
        const proposal: TraitProposal = {
          id: `prop-${randomUUID().slice(0, 8)}`,
          kind: 'trait',
          title: d.title,
          traitText: d.traitText,
          evidence: d.evidence,
        };
        traits.push(proposal);
      }
    } catch (err) {
      log.warn(
        `[growth] trait proposal generation failed for ${gezelId} — degrading to payout-only:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const unlocked = new Set(state.unlockedCosmetics.map((c) => c.id));
  return [...traits, ...buildPayoutOptions(args.frontmatter, toLevel, unlocked)];
}

async function generateTraitDrafts(args: ProposalGenArgs): Promise<TraitProposalDraft[]> {
  const { memory, store, oneShot, gezelId, state } = args;

  const cutoff = new Date(Date.now() - PROPOSAL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const all = await memory.allEntries('gezel', gezelId);
  const recent = all.filter((e) => e.day >= cutoff);
  // Newest first within the budget.
  recent.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  const corpus: CorpusEntry[] = [];
  let chars = 0;
  for (const e of recent) {
    const kind = isMemoryKind(e.kind) ? e.kind : 'fact';
    const text = e.text.replace(/\n+/g, ' ');
    if (chars + text.length > PROPOSAL_INPUT_BUDGET && corpus.length > 0) break;
    corpus.push({ day: e.day, kind, text });
    chars += text.length + 32;
  }
  if (corpus.length === 0) return [];

  const activeTraits = await store
    .getGezel(gezelId)
    .then((g) => g?.parsed.frontmatter.traits ?? [])
    .catch(() => []);
  const adoptedList = [
    ...activeTraits.map((t) => `- ${t.text}`),
    ...state.adoptedTraits.filter((t) => !t.removedAt).map((t) => `- ${t.text}`),
  ];
  const declinedList = state.declinedProposals
    .filter((d) => d.kind === 'trait' && d.traitText)
    .map((d) => `- ${d.traitText}`);

  const lessons = await store.readMemoryLessons(gezelId).catch(() => '');

  const prompt = `${PROPOSAL_PROMPT}
ALREADY ADOPTED TRAITS:
${adoptedList.length ? [...new Set(adoptedList)].join('\n') : '(none)'}

PREVIOUSLY DECLINED PROPOSALS:
${declinedList.length ? [...new Set(declinedList)].join('\n') : '(none)'}

LESSONS DOCUMENT (already in the agent's prompt — do not duplicate it):
${lessons.trim() || '(empty)'}

MEMORY ENTRIES (newest first, format: YYYY-MM-DD [kind] text):
${corpus.map((e) => `${e.day} [${e.kind}] ${e.text}`).join('\n')}`;

  const raw = await oneShot(prompt, 180_000, {
    useKlerk: true,
    jobLabel: `growth proposals · ${gezelId}`,
  });

  const drafts = parseProposalOutput(raw, corpus);
  // Never re-offer something equivalent to an adopted or declined trait.
  const excluded = new Set(
    [
      ...activeTraits.map((t) => t.text),
      ...state.adoptedTraits.map((t) => t.text),
      ...state.declinedProposals.map((d) => d.traitText ?? ''),
    ].map(normalize),
  );
  return drafts.filter((d) => !excluded.has(normalize(d.traitText)));
}
