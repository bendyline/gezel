import type { GateCheck, GateWorkspaceReader } from '@bendyline/gezel';

const PASS_LINE = '\\bPASS\\s*$';
const FAIL_LINE = '\\bFAIL\\s*$';

/**
 * Which half of the catalog's line-verdict contract `check` is: a
 * `contains /\bPASS\s*$/m` paired with a `notContains /\bFAIL\s*$/m` on the
 * same file. Arbitrary regex checks are never recognized.
 */
function verdictHalf(check: GateCheck, checks: readonly GateCheck[]): 'pass' | 'fail' | null {
  if (check.kind !== 'contains' && check.kind !== 'notContains') return null;
  const half = check.kind === 'contains' ? 'pass' : 'fail';
  if (check.pattern !== (half === 'pass' ? PASS_LINE : FAIL_LINE) || !check.flags?.includes('m'))
    return null;
  const partnerKind = half === 'pass' ? 'notContains' : 'contains';
  const partnerPattern = half === 'pass' ? FAIL_LINE : PASS_LINE;
  const paired = checks.some(
    (c) =>
      (c.kind === 'contains' || c.kind === 'notContains') &&
      c.kind === partnerKind &&
      c.file === check.file &&
      Boolean(c.artifact) === Boolean(check.artifact) &&
      c.pattern === partnerPattern &&
      c.flags?.includes('m'),
  );
  return paired ? half : null;
}

/** A decision word written as one: capitalized or in capitals, anywhere on the line. */
const MARKED_DECISION = /^(?:PASS(?:ED|ES)?|FAIL(?:S|ED|ING)?)$/i;
/**
 * A lower-case decision word counts only where the book asks for one: last
 * on a criterion line. On an indented detail line it is prose ("none failed").
 */
const FINAL_DECISION = /^(?:pass(?:ed|es)?|fail(?:s|ed)?)$/i;
/** "t" is what splitting leaves of "didn't" and "doesn't". */
const NEGATION = /^(?:not|never|no|nor|cannot|t)$/i;

function lineDecision(line: string, detail: boolean): { pass: boolean; fail: boolean } {
  // Splitting on everything but letters and digits sheds markdown (`**`,
  // `__`, `#`, `|`, list marks) and punctuation in one pass.
  const words = line.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const isMarked = (word: string) => /^[A-Z]/.test(word) && MARKED_DECISION.test(word);
  const lastIndex = words.length - 1;
  const decided = words.some(isMarked)
    ? words.flatMap((word, i) => (isMarked(word) ? [i] : []))
    : !detail && lastIndex >= 0 && FINAL_DECISION.test(words[lastIndex]!)
      ? [lastIndex]
      : [];
  // "Dates did not pass" judges the criterion failed, not passed.
  const fails = (i: number) => /^f/i.test(words[i]!) || NEGATION.test(words[i - 1] ?? '');
  return {
    pass: decided.some((i) => !fails(i)),
    fail: decided.some(fails),
  };
}

const isTableSeparator = (line: string | undefined): boolean =>
  line !== undefined && /^[\s|:-]+$/.test(line) && line.includes('-') && line.includes('|');

/** Layout around the criteria: headings, labels, rules, fences. Only asked of lines with no decision. */
function isScaffolding(trimmed: string): boolean {
  return (
    !/[A-Za-z0-9]/.test(trimmed) ||
    /^(?:>\s*)*#{1,6}(?:\s|$)/.test(trimmed) ||
    /:$/.test(trimmed.replace(/[*_]+$/, '')) ||
    /^(\*\*|__|\*|_)\S.*\1$/.test(trimmed)
  );
}

/**
 * A source list judges nothing. The evidence ledger appends `## Sources` to
 * every factual-mode file that cites `[n]`, a reviewer's verdict included,
 * and a source titled "Failing tests" must not read as a FAIL.
 */
const SOURCES_NAME =
  '(?:\\*\\*|__)?(?:sources|references|citations|bibliography|works cited|bronnen)(?:\\*\\*|__)?\\s*:?\\s*(?:\\*\\*|__)?$';
// The whole line, so a criterion heading such as "## Citations: FAIL" is still read.
const SOURCES_HEADING = new RegExp(`^(#{1,6})\\s*${SOURCES_NAME}`, 'i');
const SOURCES_LABEL = new RegExp(`^${SOURCES_NAME}`, 'i');
const SOURCE_ENTRY = /^(?:[-*+]\s*)?\[\d{1,3}\]/;
/**
 * Inside a source list only a decision written in capitals is a criterion:
 * "- Every claim cites a dated source: FAIL" under a "## Sources" heading was
 * skipped with the list and the review passed, while a title such as
 * "Failing Forward (2019)" must still read as a title.
 */
const CAPITAL_DECISION = /(?:^|[^A-Za-z0-9])(?:PASS(?:ED|ES)?|FAIL(?:S|ED|ING)?)(?:$|[^A-Za-z0-9])/;

interface LineVerdict {
  criteria: number;
  /** The first line whose decision is FAIL. */
  failed?: string;
  /** The first line that judges nothing where a criterion was expected. */
  undecided?: string;
}

/**
 * Read a reviewer's verdict the way models actually write one: headings,
 * bold, tables, and an explanation beside the decision. Strict only where
 * it matters: a FAIL anywhere, in any formatting, fails the review, and a
 * line that names a criterion without judging it is not read as a pass.
 */
export function readLineVerdict(text: string): LineVerdict {
  const lines = text.split(/\r?\n/);
  const verdict: LineVerdict = { criteria: 0 };
  const quote = (line: string) => `"${line.trim().slice(0, 120)}"`;
  // A headed list runs to the next heading at its level or above; a labeled
  // one only over its `[n]` entries, so criteria after it are still read.
  let sources: 'labeled' | number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    const heading = /^#{1,6}(?=\s|$)/.exec(trimmed)?.[0].length;
    if (typeof sources === 'number' && heading !== undefined && heading <= sources) sources = null;
    if (sources === 'labeled' && trimmed && !SOURCE_ENTRY.test(trimmed)) sources = null;
    const sourcesHeading = SOURCES_HEADING.exec(trimmed);
    if (sourcesHeading) sources = sourcesHeading[1]!.length;
    else if (SOURCES_LABEL.test(trimmed)) sources = 'labeled';
    if (
      sources !== null &&
      (sourcesHeading || SOURCE_ENTRY.test(trimmed) || !CAPITAL_DECISION.test(trimmed))
    ) {
      continue;
    }
    if (!trimmed || /^(?:```|~~~)/.test(trimmed)) continue;
    const detail = verdict.criteria > 0 && /^\s+\S/.test(line);
    const { pass, fail } = lineDecision(line, detail);
    // A header row names the columns ("Criterion | PASS/FAIL"), not a verdict.
    if (trimmed.includes('|') && isTableSeparator(lines[i + 1]) && pass === fail) continue;
    if (fail) {
      verdict.failed ??= pass
        ? `a line reports both PASS and FAIL: ${quote(line)}`
        : `a criterion reports FAIL: ${quote(line)}`;
      continue;
    }
    if (pass) {
      verdict.criteria++;
      continue;
    }
    if (detail || isScaffolding(trimmed)) continue;
    verdict.undecided ??= `a line has no PASS or FAIL decision: ${quote(line)}`;
  }
  return verdict;
}

/**
 * The verdict for one half of the line-verdict contract, replacing that
 * check's raw regex outcome; null for every other check. The regexes alone
 * read layout, not judgment: a heading or a bold PASS failed the review and
 * sent invoice-run back to re-spawn its whole crew, while a FAIL that was
 * not the line's last word passed it.
 */
export async function lineReviewVerdictOutcome(
  check: GateCheck,
  checks: readonly GateCheck[],
  ws: GateWorkspaceReader,
): Promise<{ ok: boolean; detail: string } | null> {
  const half = verdictHalf(check, checks);
  if (!half || (check.kind !== 'contains' && check.kind !== 'notContains')) return null;
  const invalid = (reason: string) => ({
    ok: false,
    detail: `${check.file}: invalid review verdict — ${reason}. Write one criterion per line, each with one PASS or FAIL decision.`,
  });
  let text: string | null | undefined;
  try {
    text = check.artifact ? await ws.readArtifact?.(check.file) : await ws.read(check.file);
  } catch {
    return half === 'pass' ? invalid('the verdict could not be read') : null;
  }
  if (!text?.trim()) return half === 'pass' ? invalid('the verdict is missing or empty') : null;
  const verdict = readLineVerdict(text);
  if (half === 'fail') {
    return verdict.failed
      ? {
          ok: false,
          detail: `${check.file}: the review failed — ${verdict.failed}. Resolve every failed criterion before advancing.`,
        }
      : { ok: true, detail: `${check.file}: no criterion reports FAIL` };
  }
  if (verdict.undecided) return invalid(verdict.undecided);
  if (verdict.criteria === 0 && !verdict.failed)
    return invalid('no criterion verdicts were provided');
  return {
    ok: true,
    detail: `${check.file}: ${verdict.criteria} criterion ${verdict.criteria === 1 ? 'line reads' : 'lines read'} PASS`,
  };
}
