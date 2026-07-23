/**
 * Pure helpers for the LLM-judge gate check (`kind: 'judge'`) —
 * prompt building, verdict parsing, and the verbatim-evidence wall.
 * No LLM calls, no filesystem: the service's gate evaluator supplies
 * the artifact text and the one-shot executor.
 *
 * The evidence wall is the growth-proposals pattern (packages/service/
 * src/growth/proposals.ts): a quote survives only when it matches the
 * artifact exactly or as a ≥24-char normalized substring — a judge
 * that fabricates its evidence loses the verdict.
 */

export const MIN_JUDGE_EVIDENCE_SUBSTRING = 24;

export interface JudgeVerdict {
  verdict: 'pass' | 'fail';
  reasons: string[];
  evidence: string[];
  confidence?: 'low' | 'medium' | 'high';
}

export function buildJudgePrompt(opts: {
  rubric: string;
  file: string;
  artifactText: string;
  sources?: Array<{ path: string; text: string }>;
  requireEvidence?: boolean;
}): string {
  const sources = (opts.sources ?? [])
    .map((s) => `--- source: ${s.path} ---\n${s.text.slice(0, 8000)}`)
    .join('\n\n');
  const evidenceRule =
    opts.requireEvidence === false
      ? ''
      : ' A "fail" verdict MUST include at least one EVIDENCE quote copied from the artifact VERBATIM, character for character — a verdict with fabricated or paraphrased evidence is discarded.';
  return [
    `You are judging one quality of a deliverable. Rubric: ${opts.rubric}`,
    sources ? `Reference material:\n\n${sources}` : '',
    `--- artifact: ${opts.file} ---\n${opts.artifactText.slice(0, 24_000)}`,
    `Reply with STRICT JSON only, matching: {"verdict": "pass" | "fail", "reasons": ["…" (max 5)], "evidence": ["verbatim quote from the artifact", …], "confidence": "low" | "medium" | "high"}.${evidenceRule} No prose outside the JSON.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Extract and validate a JudgeVerdict from a raw model reply. Accepts
 * a ```json fenced block, a bare JSON object, or JSON embedded in
 * surrounding prose (first `{` to last `}`) — the keurmeester parse
 * ladder. Throws when nothing validates.
 */
export function parseJudgeVerdict(raw: string): JudgeVerdict {
  const fenced = /```(?:json)?\s*\n?([\s\S]*?)```/.exec(raw);
  const candidates: string[] = [];
  if (fenced?.[1]) candidates.push(fenced[1]);
  candidates.push(raw.trim());
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return validateJudgeVerdict(JSON.parse(candidate));
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('no parseable judge verdict found');
}

function validateJudgeVerdict(value: unknown): JudgeVerdict {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('judge verdict must be a JSON object');
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.verdict !== 'pass' && candidate.verdict !== 'fail') {
    throw new Error('judge verdict must be "pass" or "fail"');
  }
  if (
    !Array.isArray(candidate.reasons) ||
    candidate.reasons.length > 5 ||
    candidate.reasons.some((reason) => typeof reason !== 'string' || reason.length === 0)
  ) {
    throw new Error('judge reasons must be an array of at most five non-empty strings');
  }
  const evidence = candidate.evidence ?? [];
  if (!Array.isArray(evidence) || evidence.some((quote) => typeof quote !== 'string')) {
    throw new Error('judge evidence must be an array of strings');
  }
  const confidence = candidate.confidence;
  if (
    confidence !== undefined &&
    confidence !== 'low' &&
    confidence !== 'medium' &&
    confidence !== 'high'
  ) {
    throw new Error('judge confidence must be "low", "medium", or "high"');
  }
  return {
    verdict: candidate.verdict,
    reasons: candidate.reasons,
    evidence,
    ...(confidence === undefined ? {} : { confidence }),
  };
}

function normalizeForEvidence(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The verbatim wall: keep only the quotes that actually appear in the
 * artifact (whitespace-normalized exact match, or a substring of the
 * artifact at ≥ MIN_JUDGE_EVIDENCE_SUBSTRING chars).
 */
export function validateJudgeEvidence(
  verdict: JudgeVerdict,
  artifactText: string,
): { kept: string[]; dropped: number } {
  const haystack = normalizeForEvidence(artifactText);
  const kept: string[] = [];
  let dropped = 0;
  for (const quote of verdict.evidence) {
    const needle = normalizeForEvidence(quote);
    // Quotes shorter than the substring floor are too weak to verify
    // (any common phrase matches) — they drop with the fabrications.
    if (needle.length >= MIN_JUDGE_EVIDENCE_SUBSTRING && haystack.includes(needle)) {
      kept.push(quote);
    } else {
      dropped += 1;
    }
  }
  return { kept, dropped };
}
