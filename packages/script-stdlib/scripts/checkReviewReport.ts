import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import { gateResult } from '@bendyline/gezel-sdk/checks';

/**
 * Code-review report gate (runs on a code-review task): the report artifact at
 * `reviews/<reviewId>/report.md` is structurally complete, every cited file is
 * really part of the reviewed change set (manifest entries ∪ diff headers — the
 * anti-fabrication floor that declarative `citationsResolve` cannot provide
 * across the workspace/artifacts boundary), severities use the fixed ladder,
 * and the verdict follows from the findings table.
 */
export const meta = defineScript({
  name: 'checkReviewReport',
  description:
    'Gate: a snapshot code-review report is well-formed — Summary/Findings/Verdict sections present, every cited file exists in the reviewed change set (no fabricated paths — the failure names them), severities use critical/major/minor/nit, and any critical or major finding forces a request-changes verdict.',
  kind: 'gate',
  inputs: {
    taskRef: {
      type: 'string',
      description: 'The review task (auto-filled by the runtime when this gate runs from a step).',
    },
    reviewId: {
      type: 'string',
      description:
        'Snapshot folder under the artifacts drawer (reviews/<reviewId>/). Falls back to the task craftbookParams, then the newest reviews/* folder.',
    },
  },
  outputs: {
    decision: { type: 'string', description: "'approve' or 'reject'." },
    message: { type: 'string', description: 'What passed, or the concrete gaps to fix.' },
  },
  requires: ['tasks.read', 'artifacts.read'],
} as const);

const SEVERITIES = new Set(['critical', 'major', 'minor', 'nit']);

interface TaskView {
  craftbookParams?: Record<string, string>;
}

const input = gezel.input as InferredInput<typeof meta>;

/** Strip diff/citation prefixes so `a/src/x.ts`, `./src/x.ts`, `src/x.ts` compare equal. */
function normPath(p: string): string {
  return p
    .trim()
    .replace(/^`|`$/g, '')
    .replace(/^\.\//, '')
    .replace(/^[ab]\//, '')
    .replace(/\\/g, '/');
}

async function resolveReviewId(): Promise<string | undefined> {
  if (input.reviewId) return input.reviewId;
  const task = (await gezel.task.get(input.taskRef ?? '').catch(() => null)) as TaskView | null;
  const fromParams = task?.craftbookParams?.reviewId;
  if (fromParams && !fromParams.includes('{{')) return fromParams;
  const entries = await gezel.artifacts.list('reviews/').catch(() => []);
  const manifests = entries
    .map((e) => /^reviews\/([^/]+)\/manifest\.json$/.exec(e.path)?.[1])
    .filter((id): id is string => !!id)
    .sort();
  return manifests[manifests.length - 1];
}

const gaps: string[] = [];
let okMessage = '';

const reviewId = await resolveReviewId();
if (!reviewId) {
  gezel.output(
    gateResult(
      false,
      'No review snapshot found — this gate needs a reviews/<reviewId>/ folder in the artifacts drawer (manifest.json + changes.diff).',
    ),
  );
} else {
  const reportPath = `reviews/${reviewId}/report.md`;
  const report = await gezel.artifacts.read(reportPath).catch(() => null);
  if (report === null) {
    gezel.output(
      gateResult(
        false,
        `The report has not been written yet — write the complete review to ${reportPath} with one write_artifact call.`,
      ),
    );
  } else {
    // Structural floor — name the exact missing section.
    if (!/##\s+Summary/.test(report)) gaps.push('the `## Summary` section is missing');
    if (!/##\s+Findings/.test(report)) gaps.push('the `## Findings` section is missing');
    const verdictMatch = /Verdict:\s*(approve|request-changes)/i.exec(report);
    if (!verdictMatch) {
      gaps.push(
        'the `## Verdict` section must contain a `Verdict: approve` or `Verdict: request-changes` line',
      );
    }

    // The change set = manifest file entries ∪ diff header paths. Deleted
    // files only exist in these two places, which is why the workspace is
    // deliberately NOT consulted here.
    const allowed = new Set<string>();
    const manifestRaw = await gezel.artifacts
      .read(`reviews/${reviewId}/manifest.json`)
      .catch(() => null);
    if (manifestRaw) {
      try {
        const manifest = JSON.parse(manifestRaw) as {
          files?: { path?: string; oldPath?: string }[];
        };
        for (const f of manifest.files ?? []) {
          if (f.path) allowed.add(normPath(f.path));
          if (f.oldPath) allowed.add(normPath(f.oldPath));
        }
      } catch {
        // Unparseable manifest — the diff headers still feed the set.
      }
    }
    const diffRaw = await gezel.artifacts.read(`reviews/${reviewId}/changes.diff`).catch(() => '');
    for (const m of (diffRaw ?? '').matchAll(/^(?:\+\+\+|---) (?:[ab]\/)?(.+)$/gm)) {
      const p = m[1]?.trim();
      if (p && p !== '/dev/null') allowed.add(normPath(p));
    }

    // Findings table: locate the header row, map columns by name, then
    // walk the data rows for severity vocabulary + cited files.
    const lines = report.split('\n');
    const headerIdx = lines.findIndex((l) => /^\s*\|/.test(l) && /\|\s*Severity\s*\|/i.test(l));
    const rows: { severity: string; file: string; line: number }[] = [];
    if (headerIdx >= 0) {
      const headers = lines[headerIdx]!.split('|').map((c) => c.trim().toLowerCase());
      const sevCol = headers.indexOf('severity');
      const fileCol = headers.indexOf('file');
      for (let i = headerIdx + 1; i < lines.length; i++) {
        const line = lines[i]!;
        if (!/^\s*\|/.test(line)) break;
        if (/^\s*\|[\s|:-]+\|\s*$/.test(line)) continue; // separator row
        const cells = line.split('|').map((c) => c.trim());
        rows.push({
          severity: (cells[sevCol] ?? '').toLowerCase(),
          file: cells[fileCol] ?? '',
          line: i + 1,
        });
      }
    } else if (/##\s+Findings/.test(report)) {
      gaps.push('the Findings section needs a markdown table with a `Severity` column');
    }

    const badSeverities = rows.filter((r) => r.severity !== '' && !SEVERITIES.has(r.severity));
    if (badSeverities.length > 0) {
      gaps.push(
        `severity must be one of critical/major/minor/nit — fix: ${badSeverities
          .map((r) => `"${r.severity}" (report line ${r.line})`)
          .join(', ')}`,
      );
    }

    // Citation floor: every File cell and every path:line citation in the
    // prose must name a file from the change set.
    const cited = new Set<string>();
    for (const r of rows) {
      const cell = normPath(r.file.replace(/:\d+(-\d+)?$/, ''));
      if (cell && cell !== '-' && cell !== '—') cited.add(cell);
    }
    for (const m of report.matchAll(/`([^`\s]+?\.[A-Za-z0-9]{1,8}):\d+(?:-\d+)?`/g)) {
      const p = m[1];
      if (p) cited.add(normPath(p));
    }
    const unresolved = [...cited].filter((p) => allowed.size > 0 && !allowed.has(p));
    if (unresolved.length > 0) {
      gaps.push(
        `these cited files are not part of the reviewed change set (only discuss changed files, with paths exactly as they appear in the diff): ${unresolved.join(', ')}`,
      );
    }

    // Verdict consistency: critical/major ⇒ request-changes.
    const verdict = verdictMatch?.[1]?.toLowerCase();
    const blocking = rows.filter((r) => r.severity === 'critical' || r.severity === 'major');
    if (verdict === 'approve' && blocking.length > 0) {
      gaps.push(
        `the verdict says approve but ${blocking.length} critical/major finding(s) are listed (report line(s) ${blocking
          .map((r) => r.line)
          .join(
            ', ',
          )}) — either downgrade them with justification or change the verdict to request-changes`,
      );
    }

    okMessage = `report ${reportPath} is well-formed: ${rows.length} finding(s), verdict ${verdict ?? 'n/a'}, ${cited.size} cited file(s) all inside the change set`;
    gezel.output(
      gateResult(
        gaps.length === 0,
        gaps.length === 0 ? okMessage : `The report is not ready — ${gaps.join('; ')}.`,
      ),
    );
  }
}
