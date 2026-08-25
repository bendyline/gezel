import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import { gateResult } from '@bendyline/gezel-sdk/checks';

/**
 * Fix-review gate (the enforceable `evaluate` step of the tactical fleet):
 * the reviewer's artifact at `<task.dir>/review.md` is well-formed and its
 * verdict actually routes the loop. `Verdict: PASS` advances; a well-formed
 * `Verdict: REVISE` rejects WITH `goto` back to the fix step, carrying the
 * findings as the prescriptive message; a malformed report rejects in place
 * so the reviewer repairs the report rather than the fixer thrashing.
 *
 * Anti-fabrication: every file the review cites must exist — probed by
 * reading each path (workspace, the task's diffpack overlay when drafting,
 * or the artifacts drawer), never by trusting a listing (listings truncate
 * and skip dotfiles; see core/checks/workspace-exists.ts).
 */
export const meta = defineScript({
  name: 'checkFixReview',
  description:
    'Gate: a fix/improvement review artifact is well-formed — a `Verdict: PASS` or `Verdict: REVISE` line, severities from critical/major/minor/nit, every cited file exists (workspace, draft overlay, or artifacts), critical/major findings force REVISE — and a REVISE verdict routes the task back to the fix step with the findings as the message.',
  kind: 'gate',
  inputs: {
    taskRef: {
      type: 'string',
      description: 'The task under review (auto-filled by the runtime when this gate runs).',
    },
    reviewPath: {
      type: 'string',
      description:
        "Review artifact path in the artifacts drawer. Defaults to '<task.dir>/review.md'.",
    },
    findingsPath: {
      type: 'string',
      description:
        'Optional machine-readable findings JSON (artifacts drawer). When present, its entries must agree with the findings table.',
    },
    fixStepId: {
      type: 'string',
      description: "Step to route a REVISE verdict back to. Defaults to 'fix'.",
    },
  },
  outputs: {
    decision: { type: 'string', description: "'approve' or 'reject'." },
    message: { type: 'string', description: 'What passed, or the concrete gaps / findings.' },
    // `goto` (the fix step to re-activate on a well-formed REVISE) is
    // deliberately NOT declared: every declared output field is REQUIRED by
    // the runner's coerceOutput, and the approve path emits no goto — the
    // first PASS verdict in the wild paused the task with `output is
    // missing declared field "goto"`. Undeclared fields pass through to the
    // GateScriptResult parse untouched.
  },
  requires: ['tasks.read', 'artifacts.read', 'workspace.read'],
} as const);

const SEVERITIES = new Set(['critical', 'major', 'minor', 'nit']);

interface TaskView {
  num?: number;
  artifactDir?: string;
  diffpackId?: string;
}

const input = gezel.input as InferredInput<typeof meta>;

/** Strip citation decoration so `./src/x.ts`, `a/src/x.ts`, `src/x.ts` compare equal. */
function normPath(p: string): string {
  return p
    .trim()
    .replace(/^`|`$/g, '')
    .replace(/^\.\//, '')
    .replace(/^[ab]\//, '')
    .replace(/\\/g, '/');
}

const task = (await gezel.task.get(input.taskRef ?? '').catch(() => null)) as TaskView | null;
const taskDir = task?.artifactDir ?? (task?.num !== undefined ? `tasks/${task.num}` : undefined);
const reviewPath = input.reviewPath ?? (taskDir ? `${taskDir}/review.md` : undefined);
const fixStepId = input.fixStepId ?? 'fix';

/**
 * A cited path exists when it reads from ANY surface the review may talk
 * about: the live workspace, this task's diffpack draft overlay (a drafting
 * run's fix exists only there), or the artifacts drawer (repro/validation
 * notes). A bare sibling name additionally resolves relative to the
 * review's own folder — a reviewer naturally writes "see `fix-notes.md`"
 * for the evidence doc beside the review, and rejecting that as a
 * fabricated path failed a flawless PASS verdict (wild-caught, trial 5).
 * Read-probes, never listings.
 */
async function citedPathExists(path: string, reviewDir: string): Promise<boolean> {
  if ((await gezel.fs.read(path).catch(() => null)) !== null) return true;
  if (task?.diffpackId) {
    const drafted = await gezel.artifacts
      .read(`diffpacks/${task.diffpackId}/after/${path}`)
      .catch(() => null);
    if (drafted !== null) return true;
  }
  if ((await gezel.artifacts.read(path).catch(() => null)) !== null) return true;
  if (!path.includes('/') && reviewDir) {
    if ((await gezel.artifacts.read(`${reviewDir}/${path}`).catch(() => null)) !== null) {
      return true;
    }
  }
  return false;
}

if (!reviewPath) {
  gezel.output(
    gateResult(
      false,
      'This gate could not resolve the review artifact path — pass `reviewPath` explicitly (usually `{{task.dir}}/review.md`).',
    ),
  );
} else {
  const report = await gezel.artifacts.read(reviewPath).catch(() => null);
  if (report === null) {
    gezel.output(
      gateResult(
        false,
        `The review has not been written yet — write it to the artifact ${reviewPath} with one write_artifact call, ending with a \`Verdict: PASS\` or \`Verdict: REVISE\` line.`,
      ),
    );
  } else {
    const gaps: string[] = [];
    const verdictMatch = /Verdict:\s*(PASS|REVISE)\b/i.exec(report);
    if (!verdictMatch) {
      gaps.push(
        'the review must end with a `Verdict: PASS` or `Verdict: REVISE` line (exactly one of those two words)',
      );
    }

    // Findings table (optional on PASS, expected on REVISE): header row with
    // Severity + File columns, walked for vocabulary + citations.
    const lines = report.split('\n');
    const headerIdx = lines.findIndex((l) => /^\s*\|/.test(l) && /\|\s*Severity\s*\|/i.test(l));
    const rows: { severity: string; file: string; problem: string; fix: string; line: number }[] =
      [];
    if (headerIdx >= 0) {
      const headers = lines[headerIdx]!.split('|').map((c) => c.trim().toLowerCase());
      const sevCol = headers.indexOf('severity');
      const fileCol = headers.indexOf('file');
      const problemCol = headers.findIndex((h) => h === 'problem' || h === 'finding');
      const fixCol = headers.findIndex((h) => h === 'fix' || h === 'recommendation');
      for (let i = headerIdx + 1; i < lines.length; i++) {
        const line = lines[i]!;
        if (!/^\s*\|/.test(line)) break;
        if (/^\s*\|[\s|:-]+\|\s*$/.test(line)) continue;
        const cells = line.split('|').map((c) => c.trim());
        rows.push({
          severity: (cells[sevCol] ?? '').toLowerCase(),
          file: cells[fileCol] ?? '',
          problem: problemCol >= 0 ? (cells[problemCol] ?? '') : '',
          fix: fixCol >= 0 ? (cells[fixCol] ?? '') : '',
          line: i + 1,
        });
      }
    }

    const badSeverities = rows.filter((r) => r.severity !== '' && !SEVERITIES.has(r.severity));
    if (badSeverities.length > 0) {
      gaps.push(
        `severity must be one of critical/major/minor/nit — fix: ${badSeverities
          .map((r) => `"${r.severity}" (review line ${r.line})`)
          .join(', ')}`,
      );
    }

    // Citation floor: every File cell and every backtick path:line citation
    // must resolve somewhere real.
    const cited = new Set<string>();
    for (const r of rows) {
      const cell = normPath(r.file.replace(/:\d+(-\d+)?$/, ''));
      if (cell && cell !== '-' && cell !== '—') cited.add(cell);
    }
    for (const m of report.matchAll(/`([^`\s]+?\.[A-Za-z0-9]{1,8})(?::\d+(?:-\d+)?)?`/g)) {
      const p = m[1];
      if (p) cited.add(normPath(p));
    }
    const reviewDir = reviewPath.includes('/')
      ? reviewPath.slice(0, reviewPath.lastIndexOf('/'))
      : '';
    const unresolved: string[] = [];
    for (const p of cited) {
      if (!(await citedPathExists(p, reviewDir))) unresolved.push(p);
    }
    if (unresolved.length > 0) {
      gaps.push(
        `these cited files do not exist in the workspace, this task's change proposal, or the artifacts drawer (cite real paths exactly): ${unresolved.join(', ')}`,
      );
    }

    // Optional machine handoff: the findings JSON a fix step consumes must
    // agree with the table the human reads.
    if (input.findingsPath) {
      const findingsRaw = await gezel.artifacts.read(input.findingsPath).catch(() => null);
      if (findingsRaw === null) {
        gaps.push(
          `the findings JSON is missing — write the same findings as a JSON array to the artifact ${input.findingsPath}`,
        );
      } else {
        try {
          const parsed = JSON.parse(findingsRaw) as unknown;
          if (!Array.isArray(parsed)) {
            gaps.push(`${input.findingsPath} must be a JSON ARRAY of finding objects`);
          } else if (headerIdx >= 0 && parsed.length !== rows.length) {
            gaps.push(
              `${input.findingsPath} lists ${parsed.length} finding(s) but the review table has ${rows.length} — they must agree row for row`,
            );
          }
        } catch {
          gaps.push(`${input.findingsPath} is not valid JSON`);
        }
      }
    }

    const verdict = verdictMatch?.[1]?.toUpperCase();
    const blocking = rows.filter((r) => r.severity === 'critical' || r.severity === 'major');
    if (verdict === 'PASS' && blocking.length > 0) {
      gaps.push(
        `the verdict says PASS but ${blocking.length} critical/major finding(s) are listed (line(s) ${blocking
          .map((r) => r.line)
          .join(', ')}) — either downgrade them with justification or change the verdict to REVISE`,
      );
    }
    if (verdict === 'REVISE' && rows.length === 0) {
      gaps.push(
        'the verdict says REVISE but the findings table names nothing to fix — a fixer cannot act on an empty revision request; list the concrete findings',
      );
    }

    if (gaps.length > 0) {
      gezel.output(gateResult(false, `The review is not ready — ${gaps.join('; ')}.`));
    } else if (verdict === 'REVISE') {
      const summary = rows
        .slice(0, 6)
        .map(
          (r) =>
            `- [${r.severity || 'finding'}] ${r.file}${r.problem ? ` — ${r.problem}` : ''}${r.fix ? ` → ${r.fix}` : ''}`,
        )
        .join('\n');
      gezel.output({
        decision: 'reject',
        goto: fixStepId,
        message: `Reviewer verdict: REVISE. Address these findings, then bring the work back through review:\n${summary}${rows.length > 6 ? `\n…and ${rows.length - 6} more in ${reviewPath}.` : ''}`,
      });
    } else {
      gezel.output(
        gateResult(
          true,
          `review ${reviewPath} is well-formed: verdict PASS, ${rows.length} finding(s), ${cited.size} cited path(s) all real`,
        ),
      );
    }
  }
}
