import type { CraftbookEvalGateCheck, CraftbookEvalSpec } from './types.ts';

/**
 * Which craftbook eval specs are FAMILY BOILERPLATE rather than a test of the
 * book they are named after?
 *
 * A large slice of the bundled specs were generated from a per-family
 * archetype: the same kickoff prompt, the same seeded `source/brief.md`, and
 * the same placeholder deliverable, with only `missionObjectives` naming the
 * book. So `db-index-tuning` — a recipe about reading query plans and adding
 * indexes — is measured by "look at source/records.csv and write analysis.md",
 * and `version-bump` by "write a small Node helper in src/solution.mjs".
 * Those trials PASS, and the passes were recorded as `coverage.status:
 * validated`, which is what made the gap invisible: nothing in the coverage
 * report distinguished a book proven by its own eval from a book that merely
 * sat in a family whose smoke test passed.
 *
 * The detector is deliberately mechanical and evidence-based — it does not
 * judge prose quality. A spec is boilerplate when BOTH hold:
 *
 *  1. its kickoff prompt is byte-identical to another book's, and
 *  2. no static success gate mentions any distinctive word from the book's own
 *     name.
 *
 * Condition 2 is what keeps the seven genuine families honest. The seven game
 * books legitimately share "make a browser game … index.html", and their gates
 * check game structure; a shared prompt alone is not a defect. It is the
 * combination — shared ask AND gates that never look for this book's subject —
 * that means the trial could not tell this book from its neighbour.
 */
export interface CraftbookBoilerplateFinding {
  craftbookId: string;
  scenarioId: string;
  /** Every book that ships this exact kickoff prompt, including this one. */
  sharedWith: string[];
  /** Distinctive words from the book id that no gate looks for. */
  unmatchedSubjectTerms: string[];
  /** Recorded coverage status — `validated` here is the misleading case. */
  coverageStatus: string;
}

/**
 * Words too generic to carry a book's subject. A gate matching "review" tells
 * you nothing about which of the eighteen review books ran.
 */
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'batch',
  'build',
  'check',
  'content',
  'data',
  'doc',
  'docs',
  'file',
  'files',
  'for',
  'from',
  'gen',
  'generate',
  'in',
  'of',
  'page',
  'pack',
  'plan',
  'report',
  'review',
  'run',
  'set',
  'sweep',
  'the',
  'to',
  'tool',
  'up',
  'with',
]);

function subjectTerms(craftbookId: string): string[] {
  return craftbookId
    .split('-')
    .map((part) => part.toLowerCase())
    .filter((part) => part.length >= 3 && !STOPWORDS.has(part));
}

/** Every string a static gate could match on, flattened for a substring scan. */
function gateText(spec: CraftbookEvalSpec): string {
  const parts: string[] = [];
  // The union spans several check shapes and not every member carries these
  // fields (a nodeScriptPasses check has none of them), so read them
  // structurally rather than narrowing per variant — a new check kind should
  // widen the haystack automatically, never break the scan.
  const pushCheck = (check: CraftbookEvalGateCheck): void => {
    const c = check as { pattern?: unknown; label?: unknown; file?: unknown };
    if (typeof c.pattern === 'string') parts.push(c.pattern);
    if (typeof c.label === 'string') parts.push(c.label);
    if (typeof c.file === 'string') parts.push(c.file);
  };
  for (const check of spec.success.checks ?? []) pushCheck(check);
  for (const deliverable of spec.success.deliverables ?? []) {
    parts.push(deliverable.path);
    for (const check of deliverable.checks ?? []) pushCheck(check);
  }
  for (const check of spec.success.taskNotes?.checks ?? []) pushCheck(check);
  for (const check of spec.success.taskGraph?.checks ?? []) pushCheck(check);
  return parts.join('\n').toLowerCase();
}

/**
 * Find every spec whose eval could not distinguish its book from the others
 * that share its kickoff prompt. Pass the full spec list; sharing is computed
 * across all of them, not just the ones you care about.
 */
export function findBoilerplateEvalSpecs(
  specs: readonly CraftbookEvalSpec[],
): CraftbookBoilerplateFinding[] {
  const byPrompt = new Map<string, CraftbookEvalSpec[]>();
  for (const spec of specs) {
    const prompt = spec.prompt?.trim();
    if (!prompt) continue;
    const bucket = byPrompt.get(prompt);
    if (bucket) bucket.push(spec);
    else byPrompt.set(prompt, [spec]);
  }

  const findings: CraftbookBoilerplateFinding[] = [];
  for (const bucket of byPrompt.values()) {
    if (bucket.length < 2) continue;
    for (const spec of bucket) {
      const terms = subjectTerms(spec.craftbookId);
      if (terms.length === 0) continue;
      const haystack = gateText(spec);
      const unmatched = terms.filter((term) => !haystack.includes(term));
      if (unmatched.length !== terms.length) continue;
      findings.push({
        craftbookId: spec.craftbookId,
        scenarioId: spec.scenarioId,
        sharedWith: bucket.map((s) => s.craftbookId).sort(),
        unmatchedSubjectTerms: unmatched,
        coverageStatus: spec.coverage.status,
      });
    }
  }
  return findings.sort((a, b) => a.craftbookId.localeCompare(b.craftbookId));
}
