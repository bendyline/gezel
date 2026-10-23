import {
  type ModelScore,
  SCORECARD_DATA_ATTRS,
  type ScorecardObservation,
  scorecardModelFamilyId,
} from '@bendyline/gezel';

const RUBRICS: Record<string, string> = {
  'default-html-v1': 'HTML quality',
  'campaign-code-v1': 'Code quality',
  'campaign-data-v1': 'Data quality',
  'campaign-doc-v1': 'Document quality',
};
const esc = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

function observation(value: ScorecardObservation | undefined, scale = 1, digits = 2): string {
  if (!value) return '—';
  const format = (n: number) =>
    (n / scale).toLocaleString('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  return `${format(value.median)} (${format(value.min)}–${format(value.max)}; n=${value.samples})`;
}

/** One table description feeds app Markdown and filterable site HTML. */
function tables(scores: ModelScore[]) {
  const groups = scores.flatMap(({ result }) =>
    (result.taskMeasurements ?? []).map((group) => ({ result, group })),
  );
  if (groups.length === 0) return [];
  const rubricIds = [
    ...new Set(groups.flatMap(({ group }) => group.judgments.map((judge) => judge.rubricId))),
  ].sort();
  const judges = [
    ...new Set(groups.flatMap(({ group }) => group.judgments.map((judge) => judge.judgeModel))),
  ];
  return [
    {
      title: 'Task performance',
      note: 'Native engine-log measurements across all attempted trials, including failures. Values are per-trial medians (minimum–maximum; sample count), not admission probes. Wall time includes tools. System RSS and GPU memory are separate peak measurements; do not add their medians. Periods remain separate because hardware performance can change.',
      headers: [
        'Model',
        'Period',
        'Trials',
        'Output (tok/s)',
        'Prefill (tok/s)',
        'Wall time (min)',
        'Peak system RSS (GiB)',
        'Peak GPU memory (GiB)',
      ],
      rows: groups.map(({ result, group }) => ({
        result,
        cells: [
          result.label,
          group.label,
          String(group.trials),
          observation(group.outputTokensPerSec),
          observation(group.prefillTokensPerSec),
          observation(group.durationMs, 60000, 1),
          observation(group.peakRssMb, 1024),
          observation(group.peakGpuMemMb, 1024),
        ],
      })),
    },
    {
      title: 'Artifact reviews',
      note: `Advisory means out of 10, with eligible artifact counts. Rubrics are separate and are not a combined model score. A dash means no eligible artifact was scored under that rubric. Missing artifacts have no score; excluded reviews do not enter these means. Judge: ${judges.join(', ') || 'none recorded'}. Review identity and limitations are recorded with the evaluation.`,
      headers: [
        'Model',
        'Period',
        ...rubricIds.map((id) => RUBRICS[id] ?? id),
        'No artifact',
        'Excluded reviews',
      ],
      rows: groups.map(({ result, group }) => ({
        result,
        cells: [
          result.label,
          group.label,
          ...rubricIds.map((id) => {
            const judge = group.judgments.find((value) => value.rubricId === id);
            return judge ? `${judge.meanScore.toFixed(2)}/10 (${judge.artifacts} pieces)` : '—';
          }),
          String(group.noArtifact),
          String(group.excludedReviews),
        ],
      })),
    },
  ];
}

export function taskMeasurementsMarkdown(scores: ModelScore[]): string[] {
  const cell = (value: string) =>
    esc(value)
      .replaceAll('|', '&#124;')
      .replace(/[\r\n]+/g, ' ');
  return tables(scores).flatMap((table) => [
    '',
    `**${table.title}**`,
    '',
    cell(table.note),
    '',
    `| ${table.headers.map(cell).join(' | ')} |`,
    `| ${table.headers.map(() => '---').join(' | ')} |`,
    ...table.rows.map((row) => `| ${row.cells.map(cell).join(' | ')} |`),
  ]);
}

export function taskMeasurementsHtml(scores: ModelScore[]): string {
  const attr = SCORECARD_DATA_ATTRS;
  return tables(scores)
    .flatMap((table) => [
      `<h6>${esc(table.title)}</h6>`,
      `<p>${esc(table.note)}</p>`,
      `<table><thead><tr>${table.headers.map((header) => `<th scope="col">${esc(header)}</th>`).join('')}</tr></thead><tbody>`,
      ...table.rows.map(
        ({ result, cells }) =>
          `<tr ${attr.model}="${esc(scorecardModelFamilyId(result.modelId))}" ${attr.tier}="${esc(result.tier)}">${cells.map((value) => `<td>${esc(value)}</td>`).join('')}</tr>`,
      ),
      '</tbody></table>',
    ])
    .join('\n');
}
