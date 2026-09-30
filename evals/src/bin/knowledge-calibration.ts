/**
 * `pnpm --filter @bendyline/gezel-evals run knowledge-calibration -- --home <dir> [flags]`
 *
 * Calibrate knowledge-catalog injection against REAL installed catalogs, on
 * a daemon you started yourself. The retrieval bench seeds a synthetic
 * corpus in a trial home; knowledge floors are a property of a real catalog
 * and its embedder, so this drives a running daemon that has the Handboek
 * and Wikipedia Food & Drink (see queries.ts for the pinned versions) plus
 * the relevance model installed.
 *
 *   --mode collect   start the daemon with GEZEL_KNOWLEDGE_VECTOR_FLOORS=off.
 *                    Records every knowledge candidate's cosine and raw model
 *                    score, then sweeps per-catalog floors and the knowledge
 *                    relevance bar.
 *   --mode validate  start the daemon with the floors under test (default:
 *                    the shipped table). Runs per-turn injection with the
 *                    relevance model off and on and scores what was kept.
 *
 * Flags:
 *   --home <dir>       the running daemon's GEZEL_HOME (runtime/ is read for port, token, cert)
 *   --project <id>     project to preview in (default `default`)
 *   --thresholds d,k,s relevance-model thresholds the keep sweep maps through
 *                      (default: the shipped ms-marco-minilm-l6@1 triple)
 *   --runs-dir <path>  override the output folder
 *
 * Method and the recorded run: evals/src/retrieval-bench/KNOWLEDGE-CALIBRATION-2026-09-30.md.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { RetrievalPreviewRequest, RetrievalPreviewResponse } from '@bendyline/gezel';
import { GezelClient, createTrustingFetch, readRuntime } from '@bendyline/gezel-client/node';
import { repoRoot } from '../native-bin.ts';
import {
  KNOWLEDGE_CALIBRATION_CATALOGS,
  KNOWLEDGE_CALIBRATION_QUERIES,
  type KnowledgeCalibrationQuery,
} from '../retrieval-bench/knowledge-calibration/queries.ts';
import {
  type EvidenceRow,
  scoreInjection,
  sweepKnowledgeKeep,
  sweepVectorFloor,
} from '../retrieval-bench/knowledge-calibration/sweep.ts';
import { parseArgs } from './args.ts';

/** packages/service/src/relevance/registry.ts — ms-marco-minilm-l6@1. */
const SHIPPED_THRESHOLDS = { drop: 0.00001, keep: 0.00003, strong: 0.95 };

function parseThresholds(raw: unknown) {
  if (typeof raw !== 'string') return SHIPPED_THRESHOLDS;
  const [drop, keep, strong] = raw.split(',').map(Number);
  if (![drop, keep, strong].every((v) => Number.isFinite(v))) {
    throw new Error(`--thresholds wants drop,keep,strong; got ${raw}`);
  }
  return { drop: drop!, keep: keep!, strong: strong! };
}

async function connect(home: string): Promise<GezelClient> {
  const runtime = await readRuntime(home);
  if (!runtime) throw new Error(`no running daemon found under ${home}/runtime`);
  return new GezelClient({
    baseUrl: runtime.baseUrl,
    token: runtime.token,
    ...(runtime.cert ? { fetch: createTrustingFetch({ cert: runtime.cert }) } : {}),
  });
}

async function preview(
  client: GezelClient,
  project: string,
  body: RetrievalPreviewRequest,
): Promise<RetrievalPreviewResponse> {
  return client.retrieval.previewRetrieval(project, body);
}

const knowledgeCandidates = (response: RetrievalPreviewResponse) =>
  (response.trace?.candidates ?? [])
    .filter((c) => c.source === 'knowledge')
    .map((c) => ({
      docKey: c.docKey,
      ...(c.arm ? { arm: c.arm } : {}),
      ...(c.similarity !== undefined ? { similarity: c.similarity } : {}),
      ...(c.modelScore !== undefined ? { modelScore: c.modelScore } : {}),
    }));

async function collect(client: GezelClient, project: string): Promise<EvidenceRow[]> {
  const rows: EvidenceRow[] = [];
  for (const [i, query] of KNOWLEDGE_CALIBRATION_QUERIES.entries()) {
    const response = await preview(client, project, {
      surface: 'search',
      query: query.text,
      maxResults: 30,
      warm: i === 0,
      relevanceModel: { enabled: true, thresholds: null, budgetMs: 20_000 },
    });
    rows.push({ query, candidates: knowledgeCandidates(response) });
  }
  return rows;
}

async function validate(client: GezelClient, project: string) {
  const arms: Record<string, Array<{ query: KnowledgeCalibrationQuery; kept: string[] }>> = {};
  for (const arm of ['model-off', 'model-on'] as const) {
    const rows: Array<{ query: KnowledgeCalibrationQuery; kept: string[] }> = [];
    for (const [i, query] of KNOWLEDGE_CALIBRATION_QUERIES.entries()) {
      const response = await preview(client, project, {
        surface: 'turn',
        query: query.text,
        warm: i === 0,
        relevanceModel: { enabled: arm === 'model-on' },
      });
      rows.push({
        query,
        kept: response.kept.filter((k) => k.source === 'knowledge').map((k) => k.docKey),
      });
    }
    arms[arm] = rows;
  }
  return arms;
}

function table(header: string[], rows: Array<Array<string | number>>): string {
  return [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const home = args.flags.home ? String(args.flags.home) : process.env.GEZEL_HOME;
  if (!home) throw new Error('--home <dir> (or GEZEL_HOME) must name the running daemon');
  const mode = String(args.flags.mode ?? 'collect');
  const project = String(args.flags.project ?? 'default');
  const thresholds = parseThresholds(args.flags.thresholds);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = args.flags['runs-dir']
    ? String(args.flags['runs-dir'])
    : join(repoRoot(), 'evals', 'runs', `knowledge-calibration-${mode}-${ts}`);
  await mkdir(outDir, { recursive: true });
  const client = await connect(home);
  const report: string[] = [`# Knowledge calibration — ${mode}`, ''];

  if (mode === 'collect') {
    const rows = await collect(client, project);
    await writeFile(join(outDir, 'evidence.json'), JSON.stringify(rows, null, 1));
    const withSimilarity = rows
      .flatMap((r) => r.candidates)
      .filter((c) => c.similarity !== undefined);
    if (withSimilarity.length === 0) {
      report.push(
        '> No candidate carried a similarity. Restart the daemon with `GEZEL_KNOWLEDGE_VECTOR_FLOORS=off` and a warm embedder.',
        '',
      );
    }
    const floorGrid = {
      handboek: [0.55, 0.6, 0.62, 0.63, 0.64, 0.65, 0.66, 0.67, 0.68, 0.69],
      food: [0.84, 0.85, 0.855, 0.86, 0.865, 0.87, 0.875, 0.88],
    };
    for (const [cls, catalog] of Object.entries(KNOWLEDGE_CALIBRATION_CATALOGS)) {
      const sweep = sweepVectorFloor(
        rows,
        catalog.key,
        cls as 'handboek' | 'food',
        floorGrid[cls as keyof typeof floorGrid],
      );
      report.push(
        `## Cosine floor — ${catalog.key}@${catalog.version}`,
        '',
        table(
          ['floor', 'off-topic cleared', 'on-topic answered', 'answers cleared'],
          sweep.map((s) => [
            s.floor,
            s.offTopicCleared,
            s.answered,
            `${s.answersCleared}/${s.answersWithSimilarity}`,
          ]),
        ),
        '',
      );
    }
    const keeps = sweepKnowledgeKeep(
      rows,
      thresholds,
      [0.3, 0.45, 0.5, 0.52, 0.54, 0.55, 0.56, 0.58, 0.6],
    );
    report.push(
      `## Knowledge relevance bar (thresholds ${thresholds.drop}, ${thresholds.keep}, ${thresholds.strong})`,
      '',
      table(
        ['keep', 'false injection', 'on-topic answered', 'answers kept'],
        keeps.map((k) => [
          k.keep,
          k.falseInjection,
          k.answered,
          `${k.answersKept}/${k.answersScored}`,
        ]),
      ),
      '',
    );
  } else if (mode === 'validate') {
    const arms = await validate(client, project);
    await writeFile(join(outDir, 'injection.json'), JSON.stringify(arms, null, 1));
    report.push(
      table(
        ['arm', 'false injection', 'on-topic answered', 'kept relevant', 'either injected'],
        Object.entries(arms).map(([arm, rows]) => {
          const s = scoreInjection(rows);
          return [
            arm,
            `${s.falseInjection}/${s.abstain}`,
            `${s.answered}/${s.onTopic}`,
            `${s.keptRelevant}/${s.kept}`,
            `${s.eitherInjected}/${s.either}`,
          ];
        }),
      ),
      '',
    );
  } else {
    throw new Error(`unknown --mode ${mode}; use collect or validate`);
  }

  const markdown = report.join('\n');
  await writeFile(join(outDir, 'report.md'), markdown);
  console.log(markdown);
  console.log(`\nwrote ${outDir}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
