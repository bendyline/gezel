import {
  type CatalogItemSummary,
  type CraftbookToolsetNeed,
  type TurnIntentPlan,
  craftbookInputParams,
  craftbookParamDefaults,
  mainContentParamKey,
} from '@bendyline/gezel';
import { deckTopicFromRequest, looksLikeWorkRequest } from './turn-intent-plan.js';

/**
 * The catalog tier of turn-intent routing: a craftbook's declared `triggers`
 * ("meeting minutes", "draft a social post") matched against what the person
 * is typing. Lower confidence than the exact-format routes, and it earns
 * nothing more than a proposal — the composer shows the book as a suggested
 * task the person can dismiss, and on send no prelude is written and no
 * tool is clamped. The manifest comment on `triggers` promised substring
 * matching for years; this is the first thing that does it.
 *
 * Two precision rules. A trigger matches only on word boundaries, so
 * "changelog" cannot fire from "change logging". And a book is proposed only
 * when the composer could actually start it from the text: its toolsets are
 * installed, it declares no file input, and every required parameter is
 * either the main content parameter (filled from the message) or has a
 * default.
 */
export interface TriggerCandidate {
  id: string;
  name: string;
  triggers: readonly string[];
  paramSchema?: unknown;
}

export interface TriggerMatch {
  candidate: TriggerCandidate;
  trigger: string;
}

const MIN_TRIGGER_LENGTH = 6;

function normalize(text: string): string {
  return text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The longest declared trigger the text contains, across every candidate. */
export function matchCraftbookTrigger(
  text: string,
  candidates: readonly TriggerCandidate[],
): TriggerMatch | null {
  const haystack = normalize(text);
  if (!haystack) return null;
  let best: TriggerMatch | null = null;
  for (const candidate of candidates) {
    for (const raw of candidate.triggers) {
      const trigger = normalize(raw);
      if (trigger.length < MIN_TRIGGER_LENGTH) continue;
      if (best && trigger.length <= best.trigger.length) continue;
      const pattern = new RegExp(
        `(?:^|[^\\p{L}\\p{N}])${escapeRegExp(trigger)}(?:$|[^\\p{L}\\p{N}])`,
        'u',
      );
      if (pattern.test(haystack)) best = { candidate, trigger: raw };
    }
  }
  return best;
}

/** Whether a message alone can launch this book — no picker, no setup step. */
export function triggerCandidateIsLaunchable(paramSchema: unknown): boolean {
  if (!paramSchema || typeof paramSchema !== 'object') return true;
  if (craftbookInputParams(paramSchema as Record<string, unknown>).some((input) => input.required))
    return false;
  const required = (paramSchema as { required?: unknown }).required;
  if (!Array.isArray(required)) return true;
  const defaults = craftbookParamDefaults(paramSchema as Record<string, unknown>);
  const mainKey = mainContentParamKey(paramSchema);
  return required.every(
    (key) => typeof key !== 'string' || key === mainKey || defaults[key] !== undefined,
  );
}

/** Narrow a project's craftbook listing to the books a trigger may propose. */
export function triggerCandidatesFromListing(
  items: readonly CatalogItemSummary[],
  missingToolsets: Readonly<Record<string, CraftbookToolsetNeed[]>>,
): TriggerCandidate[] {
  const out: TriggerCandidate[] = [];
  for (const item of items) {
    const manifest = item.manifest;
    if (manifest.kind !== 'craftbook-template') continue;
    if (!manifest.triggers?.length) continue;
    if ((missingToolsets[manifest.id] ?? []).length > 0) continue;
    if (!triggerCandidateIsLaunchable(manifest.paramSchema)) continue;
    out.push({
      id: manifest.id,
      name: manifest.name,
      triggers: manifest.triggers,
      ...(manifest.paramSchema ? { paramSchema: manifest.paramSchema } : {}),
    });
  }
  return out;
}

/** The plan for a trigger match, or null when the text is not asking for work. */
export function triggerPhrasePlan(
  text: string,
  candidates: readonly TriggerCandidate[],
): TurnIntentPlan | null {
  const trimmed = text.trim();
  if (!looksLikeWorkRequest(trimmed)) return null;
  const match = matchCraftbookTrigger(trimmed, candidates);
  if (!match) return null;
  const mainKey = mainContentParamKey(match.candidate.paramSchema);
  return {
    schemaVersion: 1,
    intent: 'artifact',
    route: 'craftbook',
    confidence: 'medium',
    reason: 'trigger-phrase',
    visible: true,
    display: {
      label: `Planned: ${match.candidate.name}`,
      detail: `Matched “${match.trigger}”`,
      badges: ['Craftbook'],
    },
    craftbook: {
      id: match.candidate.id,
      name: match.candidate.name,
      invocation: {
        description: trimmed,
        ...(mainKey ? { params: { [mainKey]: deckTopicFromRequest(trimmed) } } : {}),
      },
    },
    requiredTools: [],
  };
}
