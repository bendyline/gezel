/**
 * Side-by-side case pages for a docbench round: for each task, every case
 * with every model's output next to the others, its checks, its score, and
 * the judge's reasons. This is how a reader sees *why* a model scored what
 * it did — "This is a correct sentence" repeated three times reads very
 * differently from a 3 in a table.
 *
 * Static, self-contained HTML. Model output is untrusted: text is escaped,
 * and SVG is shown only through an `<img>` data URL, where scripts and
 * external references never run.
 */

import type { BenchCaseOutcome, BenchPackManifest } from '@bendyline/gezel/eval';
import { type CaseJudgement, caseScore, matchScore } from './score.ts';

type Task = BenchPackManifest['tasks'][number];

export interface CaseRow {
  readonly modelId: string;
  readonly outcome: BenchCaseOutcome;
  readonly judgement: CaseJudgement | null;
}

export interface ModelHeadline {
  readonly modelId: string;
  /** 0–100, when the round has been scored. */
  readonly docbench?: number;
}

function esc(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Safe file name for a task page. */
export function taskPageName(taskId: string): string {
  return `${taskId.replace(/[^a-z0-9-]+/giu, '-')}.html`;
}

const STYLE = `
:root { color-scheme: light dark; --bg: #fdfcfa; --fg: #1f1d1a; --muted: #6b665e; --line: #ddd8cf;
  --card: #ffffff; --good: #2f7d4a; --bad: #b3402e; --mid: #9a6b12; }
@media (prefers-color-scheme: dark) { :root { --bg: #171614; --fg: #ece8e1; --muted: #a39d93;
  --line: #3a3732; --card: #201f1c; --good: #6fc48d; --bad: #f08a76; --mid: #e0b45a; } }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg);
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 28px 0 8px; }
p.meta { color: var(--muted); margin: 0 0 12px; }
a { color: inherit; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 10px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 10px;
  min-width: 0; }
.card header { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
.card header b { overflow-wrap: anywhere; }
.score { font-variant-numeric: tabular-nums; font-weight: 600; }
.hi { color: var(--good); } .lo { color: var(--bad); } .md { color: var(--mid); }
pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 420px; overflow: auto;
  background: color-mix(in srgb, var(--line) 25%, transparent); padding: 8px; border-radius: 6px;
  font-size: 12px; margin: 6px 0; }
iframe.svg { width: 100%; height: 340px; border: 0; background: #fff; border-radius: 6px; margin: 6px 0; }
ul.checks { margin: 6px 0; padding-left: 18px; color: var(--muted); font-size: 12px; }
details { margin: 6px 0; } summary { cursor: pointer; color: var(--muted); }
table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: 4px 8px;
  border-bottom: 1px solid var(--line); font-variant-numeric: tabular-nums; }
.wrap { overflow-x: auto; }
`;

function page(title: string, body: string): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(title)}</title><style>${STYLE}</style></head>`,
    `<body>${body}</body></html>`,
  ].join('\n');
}

function tone(score: number): string {
  return score >= 0.7 ? 'hi' : score >= 0.4 ? 'md' : 'lo';
}

function artifactHtml(outcome: BenchCaseOutcome): string {
  const artifact = outcome.artifact;
  if (!artifact) return '<p class="meta">No output reached the person.</p>';
  if (artifact.kind === 'svg') {
    // Parsed as HTML, as the judge's renderer parses it, so a picture the
    // judge saw is not shown broken here for a lapse a strict XML parser
    // rejects. The empty sandbox runs no script and reaches nothing.
    const doc = `<!doctype html><style>html,body{margin:0;background:#fff}svg{display:block;width:100%;height:auto}</style>${artifact.content}`;
    return `<iframe class="svg" sandbox="" loading="lazy" title="The model's picture" srcdoc="${esc(doc)}"></iframe>`;
  }
  let text = artifact.content;
  if (artifact.kind === 'json') {
    try {
      text = JSON.stringify(JSON.parse(artifact.content), null, 2);
    } catch {
      // Shown as sent when it does not parse.
    }
  }
  return `<pre>${esc(text)}</pre>`;
}

function judgementHtml(judgement: CaseJudgement | null): string {
  if (!judgement) return '';
  if (judgement.error) return `<p class="meta">Judge failed: ${esc(judgement.error)}</p>`;
  const parts: string[] = [];
  if (judgement.match) {
    const m = judgement.match;
    const f1 = matchScore(m);
    parts.push(
      `found ${String(m.found)}/${String(m.keyTotal)} · valid ${String(m.valid)} · trivial ${String(m.trivial)} · wrong ${String(m.wrong)} · F1 ${f1.f1.toFixed(2)}`,
    );
  }
  const axes = Object.entries(judgement.axes);
  if (axes.length > 0) {
    parts.push(axes.map(([axis, value]) => `${axis} ${String(value)}`).join(' · '));
  }
  return [
    parts.length > 0 ? `<p class="meta">${esc(parts.join(' — '))}</p>` : '',
    `<details><summary>Judge's reasons</summary><p>${esc(judgement.reasons)}</p></details>`,
  ].join('');
}

function cardHtml(task: Task, row: CaseRow, trials: number): string {
  const { outcome, judgement } = row;
  const scored = caseScore(outcome, task, judgement);
  const label = trials > 1 ? `${row.modelId} · trial ${String(outcome.trial + 1)}` : row.modelId;
  const failed = outcome.checks.filter((check) => check.score < 1);
  const tokens = outcome.calls.reduce((sum, call) => sum + (call.completionTokens ?? 0), 0);
  return [
    '<article class="card">',
    `<header><b>${esc(label)}</b><span class="score ${tone(scored.score)}">${String(Math.round(scored.score * 100))}${scored.judged ? '' : ' (unjudged)'}</span></header>`,
    `<p class="meta">${outcome.usable ? 'usable' : '<span class="lo">not usable</span>'} · ${String(tokens)} output tokens · ${(outcome.ms / 1000).toFixed(1)} s${outcome.error ? ` · ${esc(outcome.error.class)} error: ${esc(outcome.error.message)}` : ''}</p>`,
    failed.length > 0
      ? `<ul class="checks">${failed
          .map(
            (check) =>
              `<li>${esc(check.label)}${check.detail ? ` — ${esc(check.detail)}` : ''}</li>`,
          )
          .join('')}</ul>`
      : '',
    judgementHtml(judgement),
    artifactHtml(outcome),
    '</article>',
  ].join('');
}

function caseContextHtml(rows: readonly CaseRow[]): string {
  const input = rows.find((row) => row.outcome.judgeInput)?.outcome.judgeInput;
  if (!input) return '';
  const key = input.answerKey ?? [];
  return [
    `<details><summary>The source the models were given</summary><pre>${esc(input.context)}</pre></details>`,
    key.length > 0
      ? `<details><summary>Answer key (${String(key.length)} issues)</summary><ul>${key
          .map(
            (item) =>
              `<li>${item.level ? `<b>${esc(item.level)}</b> ` : ''}${esc(item.issue)}${item.quote ? ` — “${esc(item.quote)}”` : ''}</li>`,
          )
          .join('')}</ul></details>`
      : '',
    input.reference
      ? `<details><summary>Reference answer</summary><pre>${esc(input.reference)}</pre></details>`
      : '',
  ].join('');
}

/**
 * One task's page: every case, each model's outputs side by side in the
 * round's ranking order.
 */
export function renderTaskCasesPage(input: {
  readonly runId: string;
  readonly task: Task;
  readonly rows: readonly CaseRow[];
  readonly models: readonly ModelHeadline[];
}): string {
  const { task } = input;
  const order = new Map(input.models.map((model, index) => [model.modelId, index]));
  const rank = (row: CaseRow) => order.get(row.modelId) ?? Number.MAX_SAFE_INTEGER;
  const sections = task.cases.map((item) => {
    const rows = input.rows
      .filter((row) => row.outcome.caseId === item.id)
      .sort((a, b) => rank(a) - rank(b) || a.outcome.trial - b.outcome.trial);
    if (rows.length === 0) return '';
    return [
      `<h2 id="${esc(item.id)}">${esc(item.label || item.id)}</h2>`,
      caseContextHtml(rows),
      `<div class="grid">${rows.map((row) => cardHtml(task, row, task.trials)).join('')}</div>`,
    ].join('');
  });
  return page(
    `${task.label} — ${input.runId}`,
    [
      `<p class="meta"><a href="index.html">All tasks</a> · round ${esc(input.runId)}</p>`,
      `<h1>${esc(task.label)}</h1>`,
      `<p class="meta">${esc(task.description)} Scores are 0–100 per output: ${String(Math.round(task.scoring.checks * 100))}% automatic checks, ${String(Math.round(task.scoring.judge * 100))}% judge; an output the product could not use scores 0.</p>`,
      ...sections,
    ].join('\n'),
  );
}

/** A model's mean output score on one task, and whether every verdict it needs is in. */
export interface TaskMean {
  readonly score: number;
  readonly judged: boolean;
}

/** The round's index: models in ranking order and a link to each task. */
export function renderCasesIndex(input: {
  readonly runId: string;
  readonly manifest: BenchPackManifest;
  readonly models: readonly ModelHeadline[];
  readonly taskScores: ReadonlyMap<string, ReadonlyMap<string, TaskMean>>;
}): string {
  const { manifest, models } = input;
  const provisional = [...input.taskScores.values()].some((scores) =>
    [...scores.values()].some((mean) => !mean.judged),
  );
  const header = `<tr><th>Task</th>${models
    .map(
      (model) =>
        `<th>${esc(model.modelId)}${model.docbench === undefined ? '' : `<br><span class="score">${String(Math.round(model.docbench))}</span>`}</th>`,
    )
    .join('')}</tr>`;
  const rows = manifest.tasks.map((task) => {
    const scores = input.taskScores.get(task.id);
    return `<tr><td><a href="${taskPageName(task.id)}">${esc(task.label)}</a></td>${models
      .map((model) => {
        const mean = scores?.get(model.modelId);
        if (!mean) return '<td>–</td>';
        const value = `${String(Math.round(mean.score * 100))}${mean.judged ? '' : '*'}`;
        return `<td class="score ${mean.judged ? tone(mean.score) : ''}">${value}</td>`;
      })
      .join('')}</tr>`;
  });
  return page(
    `docbench cases — ${input.runId}`,
    [
      `<h1>docbench ${esc(manifest.version)} — ${esc(input.runId)}</h1>`,
      '<p class="meta">Mean output score per task (0–100), models in ranking order. Open a task to see every case side by side.</p>',
      provisional
        ? '<p class="meta">* Not every output has its verdict yet: the number is the automatic checks alone, which run high.</p>'
        : '',
      `<div class="wrap"><table>${header}${rows.join('')}</table></div>`,
    ].join('\n'),
  );
}
