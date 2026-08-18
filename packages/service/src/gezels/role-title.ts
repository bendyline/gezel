/**
 * Display casing for a free-text job title.
 *
 * A bespoke-created gezel stores the caller's raw job title and the sidebar
 * renders it verbatim, so whatever casing arrives is what the user reads.
 * Callers are not careful: Gilde craftbooks carry lowercase `suggestedRole`
 * values ("application security engineer") and a model's `create_gezel`
 * argument is unconstrained prose.
 *
 * Words that already carry an uppercase letter are left untouched, so a
 * caller that sent deliberate casing keeps it and this is a no-op on the
 * common path.
 */

/**
 * Acronyms worth restoring — sentence-casing these reads as a typo ("Qa
 * Engineer"). Deliberately narrow: only forms that appear in real job
 * titles, and only ones conventionally written in full caps (so no
 * "DevOps", whose shape this function cannot express).
 */
const ACRONYMS = new Set([
  'ai',
  'api',
  'ceo',
  'cfo',
  'ciso',
  'cso',
  'cto',
  'hr',
  'it',
  'ml',
  'qa',
  'seo',
  'sre',
  'ui',
  'ux',
]);

/** Kept lowercase unless they lead the title — "Director of Engineering". */
const MINOR_WORDS = new Set([
  'a',
  'an',
  'and',
  'at',
  'by',
  'for',
  'in',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
]);

export function titleCaseRole(role: string): string {
  const trimmed = role.trim();
  if (!trimmed) return trimmed;
  let leading = true;
  return trimmed.replace(/[A-Za-z0-9]+/g, (word) => {
    const isLeading = leading;
    leading = false;
    if (/[A-Z]/.test(word)) return word;
    if (ACRONYMS.has(word)) return word.toUpperCase();
    if (!isLeading && MINOR_WORDS.has(word)) return word;
    return word[0]!.toUpperCase() + word.slice(1);
  });
}
