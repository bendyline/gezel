import type { GateCheck, GateWorkspaceReader } from '@bendyline/gezel';

/** Recognize the existing catalog's explicit line-verdict contract, not arbitrary regex checks. */
export async function lineReviewVerdictFailure(
  check: GateCheck,
  checks: readonly GateCheck[],
  ws: GateWorkspaceReader,
): Promise<string | null> {
  if (
    check.kind !== 'notContains' ||
    check.pattern !== '\\bFAIL\\s*$' ||
    !check.flags?.includes('m')
  )
    return null;
  const paired = checks.some(
    (c) =>
      c.kind === 'contains' &&
      c.file === check.file &&
      Boolean(c.artifact) === Boolean(check.artifact) &&
      c.pattern === '\\bPASS\\s*$' &&
      c.flags?.includes('m'),
  );
  if (!paired) return null;
  const reject = (reason: string) =>
    `${check.file}: invalid review verdict — ${reason}. Write one criterion per line, ending in PASS or FAIL; resolve every failed criterion before advancing.`;
  try {
    const text = check.artifact ? await ws.readArtifact?.(check.file) : await ws.read(check.file);
    if (!text?.trim()) return reject('the verdict is missing or empty');
    let criteria = 0;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const decisions = line.match(/\b(?:PASS|FAIL)\b/gi) ?? [];
      if (decisions.some((word) => word.toUpperCase() === 'FAIL'))
        return reject('a criterion reports FAIL');
      if (decisions.length === 1 && /\S.*\sPASS\s*$/.test(line.trim())) {
        criteria++;
      } else if (!(criteria > 0 && /^\s+\S/.test(line) && decisions.length === 0)) {
        return reject('a line has missing, ambiguous, or incorrectly placed decision text');
      }
    }
    return criteria > 0 ? null : reject('no criterion verdicts were provided');
  } catch {
    return reject('the verdict could not be read');
  }
}
