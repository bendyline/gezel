/**
 * The docbench section of the published scorecard: how well each model does
 * DocBlocks' document work (review, writing, diagrams, slides, study aids,
 * narration cleanup), as a judged 0–100 score.
 *
 * Kept apart from the pass-rate tables on purpose. A docbench row's `cells`
 * count usable replies so the dataset stays uniform, but a usable reply is
 * not a pass, and printing it under a "Tasks passed" header would turn a
 * judged quality score into a claim the data does not make. Same honesty
 * rules as the rest of the scorecard otherwise: each round under its own
 * stamp, never merged, the interval printed beside every score, and models
 * whose intervals overlap sharing a band rather than a false exact rank.
 */

import {
  DOCBENCH_SUITE_ID,
  type ScorecardDataset,
  type ScorecardDocbench,
  type ScorecardModelResult,
  type ScorecardRun,
  hardwareSummary,
} from '@bendyline/gezel';

/** Families in the pack's order, with the words the articles use. */
const FAMILY_COLUMNS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'review', label: 'Review' },
  { id: 'writing', label: 'Writing' },
  { id: 'visuals', label: 'Pictures' },
  { id: 'presentations', label: 'Slides' },
  { id: 'study', label: 'Study' },
  { id: 'narration', label: 'Narration' },
];

/** Earlier docbench rounds listed beneath the newest, each in its own table. */
const PRIOR_DOCBENCH_ROUNDS_SHOWN = 2;

interface DocbenchRow {
  result: ScorecardModelResult;
  docbench: ScorecardDocbench;
}

interface DocbenchRound {
  run: ScorecardRun;
  rows: DocbenchRow[];
}

/** Every round that recorded docbench scores, newest first, ranked within. */
export function docbenchRounds(dataset: ScorecardDataset): DocbenchRound[] {
  return dataset.runs
    .filter((run) => run.suites.includes(DOCBENCH_SUITE_ID))
    .sort((a, b) => b.provenance.startedAt.localeCompare(a.provenance.startedAt))
    .map((run) => ({
      run,
      rows: dataset.results
        .filter((result) => result.runId === run.id && result.suiteId === DOCBENCH_SUITE_ID)
        .flatMap((result) => (result.docbench ? [{ result, docbench: result.docbench }] : []))
        .sort(
          (a, b) =>
            a.docbench.band - b.docbench.band ||
            b.docbench.score - a.docbench.score ||
            a.result.label.localeCompare(b.result.label),
        ),
    }))
    .filter((round) => round.rows.length > 0);
}

function cell(value: string): string {
  return value.replaceAll('|', '\\|');
}

function whole(value: number): string {
  return String(Math.round(value));
}

function stamp(round: DocbenchRound): string {
  const { run, rows } = round;
  const first = rows[0]!.docbench;
  const judges = [...new Set(rows.map((row) => row.docbench.judge.model))];
  const valid = rows.every((row) => row.docbench.judge.validityPassed);
  const engines = [...new Set(rows.map((row) => row.result.engine))];
  const parts = [
    run.provenance.startedAt.slice(0, 10),
    hardwareSummary(run.provenance.device),
    `${engines.join(', ')}`,
    `pack ${first.packVersion}`,
    `judged by ${judges.join(', ')}${valid ? '' : ' (judge not yet validated)'}`,
  ];
  return `**${parts.join(' · ')}**`;
}

/**
 * One round's table. `remeasured` names models a later focused re-run
 * measured again, so a reader of the headline knows the row has a newer
 * number below rather than taking the old one as current.
 */
function roundTable(round: DocbenchRound, remeasured: ReadonlySet<string> = new Set()): string[] {
  const families = FAMILY_COLUMNS.filter((family) =>
    round.rows.some((row) => row.docbench.families[family.id]),
  );
  const extra = [
    ...new Set(round.rows.flatMap((row) => Object.keys(row.docbench.families))),
  ].filter((id) => !FAMILY_COLUMNS.some((family) => family.id === id));
  const columns = [...families, ...extra.map((id) => ({ id, label: id }))];
  const lines = [
    `| Band | Model | Size | Docbench | 95% range | ${columns.map((c) => c.label).join(' | ')} | Usable |`,
    `| ---: | --- | ---: | ---: | ---: | ${columns.map(() => '---:').join(' | ')} | ---: |`,
  ];
  for (const { result, docbench } of round.rows) {
    const familyCells = columns.map((column) => {
      const family = docbench.families[column.id];
      return family ? whole(family.score) : '–';
    });
    lines.push(
      [
        '',
        String(docbench.band),
        cell(remeasured.has(result.modelId) ? `${result.label} (re-measured below)` : result.label),
        cell(result.parameterSize ?? '–'),
        `**${whole(docbench.score)}**`,
        `${whole(docbench.ci[0])}–${whole(docbench.ci[1])}`,
        ...familyCells,
        `${Math.round(docbench.usableRate * 100)}%`,
        '',
      ]
        .join(' | ')
        .trim(),
    );
  }
  return lines;
}

/**
 * Review depth: how many genuine suggestions each model found per document,
 * by how much they would change it, against the noise it added. Present
 * only when the round judged the general review task.
 */
function reviewDepthTable(round: DocbenchRound): string[] {
  const rows = round.rows.flatMap(({ result, docbench }) => {
    const findings = docbench.tasks['review-general']?.findings;
    return findings ? [{ result, findings }] : [];
  });
  if (rows.length === 0) return [];
  const one = (value: number) => value.toFixed(1);
  return [
    '',
    'Suggestions per document in general review (moderate-quality drafts):',
    '',
    '| Model | Small fixes | Moderate | Substantial | Trivial | Wrong |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map(
      ({ result, findings }) =>
        `| ${cell(result.label)} | ${one(findings.low)} | ${one(findings.medium)} | ${one(findings.high)} | ${one(findings.trivial)} | ${one(findings.wrong)} |`,
    ),
  ];
}

/** Pure renderer behind `::handboek-docbench-scorecard`. */
export function renderDocbenchScorecardMarkdown(dataset: ScorecardDataset): string {
  const rounds = docbenchRounds(dataset);
  if (rounds.length === 0) {
    return 'No docbench round has been published yet.';
  }
  // A focused re-run (scope `subset`) measures a few models again after a
  // fix. It never becomes the headline: a two-model table would read as the
  // whole field. It sits under the round it re-measures, with its own stamp.
  const full = rounds.filter((round) => round.run.scope !== 'subset');
  const latest = full[0] ?? rounds[0]!;
  const reruns = rounds.filter(
    (round) =>
      round.run.scope === 'subset' &&
      round.run.provenance.startedAt >= latest.run.provenance.startedAt,
  );
  const earlier = full.filter((round) => round !== latest);
  const remeasured = new Set(
    reruns.flatMap((round) => round.rows.map((row) => row.result.modelId)),
  );
  const lines: string[] = [
    stamp(latest),
    '',
    ...roundTable(latest, remeasured),
    ...reviewDepthTable(latest),
  ];
  if (latest.run.note) lines.push('', cell(latest.run.note));
  for (const round of reruns) {
    lines.push('', `### Focused re-run — ${round.run.provenance.startedAt.slice(0, 10)}`);
    lines.push('', stamp(round), '', ...roundTable(round));
    if (round.run.note) lines.push('', cell(round.run.note));
  }
  for (const round of earlier.slice(0, PRIOR_DOCBENCH_ROUNDS_SHOWN)) {
    lines.push('', `### Earlier docbench round — ${round.run.provenance.startedAt.slice(0, 10)}`);
    lines.push('', stamp(round), '', ...roundTable(round));
  }
  return lines.join('\n');
}
