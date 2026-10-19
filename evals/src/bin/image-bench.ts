/**
 * `pnpm --filter @bendyline/gezel-evals run image-bench -- [flags]`
 *
 * Renders a fixed prompt suite through every local image model the way a
 * person's request does: a fresh trial daemon per model, `POST
 * /api/image-gen/generate` with only the prompt, model and seed, so the
 * catalog's steps and the provider's CFG, sampler, size and launch flags all
 * apply. Records per image the wall time, the engine's own phase timings,
 * the model-free sanity flags, and (with the media-search model cached) a
 * prompt-alignment score; per model the cold start, steady seconds per
 * image, and peak memory against the daemon's own estimate from
 * `/api/image-gen/models/fit`.
 *
 * Flags:
 *   --models <a,b>       catalog ids (default: every sd-cpp model in the cache)
 *   --cache <home>       eval model cache (default ~/.gezel-eval-cache)
 *   --sd-bin <path>      sd-server (default: the staged native binary, CUDA first)
 *   --sd-lib-dir <dir>   prepended to the daemon's LD_LIBRARY_PATH, for a local
 *                        build that lacks the release's $ORIGIN rpath
 *   --suite <name>       smoke | sanity (default sanity)
 *   --prompts <a,b>      prompt ids instead of a suite
 *   --prompt-file <path> JSON {"<prompt id>": "<text sent instead>"}: render a
 *                        rewritten prompt (say, one a chat model expanded) while
 *                        alignment still scores the image against the original
 *                        request
 *   --seeds <a,b>        default 42
 *   --size <WxH>         override the model's default size
 *   --steps <n>          override the catalog's recommended steps
 *   --label <name>       arm label for A/B runs (default "default")
 *   --runs-dir <path>    output (default evals/runs/image-bench-<ts>)
 *   --hf-cache <dir>     transformers cache holding the media-search model
 *                        (default GEZEL_HF_CACHE_DIR, else ~/.gezel/engines/hf-cache)
 *   --no-align           skip alignment scoring
 *   --judge-url <url>    OpenAI-compatible base URL of a vision chat model
 *                        (e.g. http://127.0.0.1:8080/v1) that reads every image
 *   --judge-model <id>   model name to send it (default "judge")
 *   --judge-key <token>  bearer token for it
 *   --judge-body <json>  extra request fields, e.g.
 *                        '{"chat_template_kwargs":{"reasoning_strength":"low"}}'
 *   --rescore            re-score the images already in --runs-dir (alignment
 *                        and judge) without rendering anything; images that
 *                        already have a verdict keep it, so a pass resumes
 *   --judge-max <n>      judge at most n images this pass: llama-server with a
 *                        vision projector stopped answering after about 50
 *                        image requests (v0.7.0, 2026-10), so restart it between
 *                        passes
 *
 * Method, thresholds and recorded runs: evals/src/image-bench/IMAGE-BENCH.md.
 */
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import type { MediaModelFit } from '@bendyline/gezel';
import { decodeImage } from '@bendyline/gezel-service/media';
import { acquireEvalDeviceLock } from '../eval-device-lock.ts';
import { type AlignmentScore, createAlignmentScorer } from '../image-bench/alignment.ts';
import { type JudgeEndpoint, type JudgeVerdict, judgeImage } from '../image-bench/judge.ts';
import { type MemoryPeak, MemoryWatch } from '../image-bench/memory.ts';
import {
  IMAGE_BENCH_PROMPTS,
  type ImageBenchPrompt,
  resolveImageBenchPrompts,
} from '../image-bench/prompts.ts';
import {
  type ImageStats,
  type SanityFlag,
  imageStats,
  sanityFlags,
} from '../image-bench/sanity.ts';
import { type SdServerLog, parseSdServerLog } from '../image-bench/sd-log.ts';
import { defaultCacheRoot, linkModelIntoTrial } from '../model-cache.ts';
import { repoRoot, resolveSdBinary } from '../native-bin.ts';
import { findTrialNativeChildren, shutdownTrialDaemon, spawnTrialDaemon } from '../spawn.ts';
import { parseArgs } from './args.ts';

const GIB = 1024 ** 3;

interface ImageRecord {
  label: string;
  model: string;
  prompt: string;
  category: string;
  seed: number;
  file?: string;
  error?: string;
  wallSeconds: number;
  steps?: number;
  width?: number;
  height?: number;
  stats?: ImageStats;
  flags?: SanityFlag[];
  alignment?: AlignmentScore;
  judge?: JudgeVerdict;
  judgeError?: string;
  /** Peak memory drop so far, read after this image: a rising series across images is a leak. */
  peakSoFarBytes?: number;
}

interface ModelRecord {
  label: string;
  model: string;
  fit?: MediaModelFit;
  images: number;
  failures: number;
  coldSeconds?: number;
  steadySeconds?: number;
  memory: MemoryPeak;
  engine: SdServerLog;
  flagged: Record<string, number>;
}

const list = (v: unknown) =>
  typeof v === 'string'
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[Math.floor((s.length - 1) / 2)] as number) : undefined;
};

async function cachedImageModels(cache: string): Promise<string[]> {
  const root = join(cache, 'engines', 'sd-cpp', 'models');
  const ids: string[] = [];
  for (const id of await readdir(root).catch(() => [])) {
    if (existsSync(join(root, id, 'manifest.json'))) ids.push(id);
  }
  return ids.sort();
}

function defaultHfCache(): string | undefined {
  const fromEnv = process.env.GEZEL_HF_CACHE_DIR;
  if (fromEnv) return fromEnv;
  const home = join(homedir(), '.gezel', 'engines', 'hf-cache');
  return existsSync(join(home, 'onnx-community', 'embeddinggemma-2-ONNX')) ? home : undefined;
}

async function runModel(opts: {
  model: string;
  label: string;
  cache: string;
  sdBin: string;
  sdLibDir?: string;
  prompts: ImageBenchPrompt[];
  seeds: number[];
  size?: { width: number; height: number };
  steps?: number;
  rewrites?: Record<string, string>;
  outDir: string;
}): Promise<{ model: ModelRecord; images: ImageRecord[] }> {
  const { model, label, outDir } = opts;
  const modelDir = join(outDir, label, model);
  const home = join(outDir, 'homes', `${label}-${model}`);
  await rm(home, { recursive: true, force: true });
  await mkdir(modelDir, { recursive: true });
  await linkModelIntoTrial({
    cacheRoot: opts.cache,
    trialHome: home,
    engine: 'sd-cpp',
    modelId: model,
  });
  const logPath = join(modelDir, 'daemon.log');
  const watch = new MemoryWatch(() => findTrialNativeChildren(home));
  const daemon = await spawnTrialDaemon({
    home,
    sdBin: opts.sdBin,
    stderrLogPath: logPath,
    extraEnv: {
      GEZEL_LOG_LEVEL: 'info',
      ...(opts.sdLibDir
        ? {
            LD_LIBRARY_PATH: [opts.sdLibDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
          }
        : {}),
    },
  });
  const images: ImageRecord[] = [];
  let fit: MediaModelFit | undefined;
  let memory: MemoryPeak;
  try {
    await daemon.client.updateConfig({ imageProvider: 'sd-cpp', firstRunCompleted: true });
    fit = (await daemon.client.getImageModelFit()).models.find((m) => m.id === model);
    // The baseline excludes the daemon itself: sd-server starts on the first generate.
    await watch.begin();
    for (const prompt of opts.prompts) {
      for (const seed of opts.seeds) {
        const started = performance.now();
        const record: ImageRecord = {
          label,
          model,
          prompt: prompt.id,
          category: prompt.category,
          seed,
          wallSeconds: 0,
        };
        try {
          const res = await daemon.client.generateImage({
            prompt: opts.rewrites?.[prompt.id] ?? prompt.prompt,
            model,
            seed,
            ...(opts.size ? opts.size : {}),
            ...(opts.steps ? { steps: opts.steps } : {}),
            inline: true,
          });
          record.wallSeconds = (performance.now() - started) / 1000;
          record.steps = res.meta.steps;
          record.width = res.meta.widthPx;
          record.height = res.meta.heightPx;
          if (!res.b64Png) throw new Error('response carried no image bytes');
          const png = Buffer.from(res.b64Png, 'base64');
          const file = join(modelDir, `${prompt.id}-s${seed}.png`);
          await writeFile(file, png);
          record.file = relative(outDir, file);
          record.stats = imageStats(decodeImage(png));
          record.flags = sanityFlags(record.stats, {
            width: res.meta.widthPx,
            height: res.meta.heightPx,
          });
        } catch (err) {
          record.wallSeconds = (performance.now() - started) / 1000;
          record.error = err instanceof Error ? err.message : String(err);
        }
        record.peakSoFarBytes = (await watch.peak()).systemDropBytes ?? undefined;
        images.push(record);
        console.log(
          `[image-bench] ${label} ${model} ${prompt.id} s${seed}: ${record.error ? `ERROR ${record.error.slice(0, 160)}` : `${record.wallSeconds.toFixed(1)}s ${record.width}x${record.height} ${record.steps} steps${record.flags?.length ? ` flags=${record.flags.join(',')}` : ''}`}`,
        );
      }
    }
  } finally {
    memory = await watch.peak();
    await shutdownTrialDaemon(daemon);
    await watch.end();
  }
  const lines = (await readFile(logPath, 'utf8').catch(() => '')).split('\n');
  const engine = parseSdServerLog(lines.filter((l) => l.includes('[sd-server]')));
  const ok = images.filter((i) => !i.error);
  const flagged: Record<string, number> = {};
  for (const i of ok) for (const f of i.flags ?? []) flagged[f] = (flagged[f] ?? 0) + 1;
  const record: ModelRecord = {
    label,
    model,
    ...(fit ? { fit } : {}),
    images: ok.length,
    failures: images.length - ok.length,
    ...(ok[0] ? { coldSeconds: ok[0].wallSeconds } : {}),
    ...(ok.length > 1 ? { steadySeconds: median(ok.slice(1).map((i) => i.wallSeconds)) } : {}),
    memory,
    engine,
    flagged,
  };
  await writeFile(join(modelDir, 'model.json'), JSON.stringify(record, null, 2));
  return { model: record, images };
}

const gb = (bytes: number | null | undefined) =>
  bytes === null || bytes === undefined ? '-' : (bytes / GIB).toFixed(1);
const sec = (s: number | undefined) => (s === undefined ? '-' : s.toFixed(1));

function reportMarkdown(models: ModelRecord[], images: ImageRecord[]): string {
  const rows = models.map((m) => {
    const own = images.filter((i) => i.model === m.model && i.label === m.label && i.alignment);
    const top1 = own.length
      ? own.filter((i) => i.alignment?.rank === 1).length / own.length
      : undefined;
    const cos = own.length
      ? own.reduce((s, i) => s + (i.alignment?.cosine ?? 0), 0) / own.length
      : undefined;
    const judged = images.filter((i) => i.model === m.model && i.label === m.label && i.judge);
    const judgeScore = judged.length
      ? judged.reduce((s, i) => s + (i.judge?.score ?? 0), 0) / judged.length
      : undefined;
    const withText = judged.filter((i) => i.judge?.textCorrect !== undefined);
    const est = m.fit?.bytes;
    const measured = m.memory.systemDropBytes;
    return [
      m.label,
      m.model,
      `${m.images}/${m.images + m.failures}`,
      sec(m.coldSeconds),
      sec(m.steadySeconds),
      gb(measured),
      gb(est),
      est && measured ? (measured / est).toFixed(2) : '-',
      m.fit?.verdict ?? '-',
      m.engine.paramsMiB !== undefined ? (m.engine.paramsMiB / 1024).toFixed(1) : '-',
      top1 === undefined ? '-' : `${Math.round(top1 * 100)}%`,
      cos === undefined ? '-' : cos.toFixed(3),
      judgeScore === undefined ? '-' : judgeScore.toFixed(1),
      withText.length
        ? `${withText.filter((i) => i.judge?.textCorrect).length}/${withText.length}`
        : '-',
      Object.entries(m.flagged)
        .map(([f, n]) => `${f}×${n}`)
        .join(' ') || '-',
    ].join(' | ');
  });
  return [
    '| arm | model | ok | cold s | steady s/img | peak GB | estimate GB | peak/est | fit | params GB | align top-1 | align cos | judge 1-5 | text right | flags |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r} |`),
    '',
  ].join('\n');
}

function reportHtml(
  models: ModelRecord[],
  images: ImageRecord[],
  prompts: ImageBenchPrompt[],
): string {
  const cols = models.map((m) => `${m.label}/${m.model}`);
  const cell = (i: ImageRecord | undefined) => {
    if (!i) return '<td></td>';
    if (i.error) return `<td class="err">${i.error.replace(/</g, '&lt;').slice(0, 200)}</td>`;
    const notes = [
      `${i.wallSeconds.toFixed(1)}s`,
      i.alignment ? `#${i.alignment.rank} ${i.alignment.cosine.toFixed(3)}` : '',
      i.judge
        ? `judge ${i.judge.score}${i.judge.textCorrect === false ? ` text "${i.judge.text.replace(/</g, '&lt;').slice(0, 40)}"` : ''}`
        : '',
      i.flags?.length ? `<b>${i.flags.join(',')}</b>` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    return `<td><a href="${i.file}"><img src="${i.file}" loading="lazy"></a><div>s${i.seed} · ${notes}</div></td>`;
  };
  const body = prompts
    .map((p) => {
      const seeds = [...new Set(images.filter((i) => i.prompt === p.id).map((i) => i.seed))];
      return seeds
        .map(
          (seed) =>
            `<tr><th>${p.id}<div>${p.expect}</div></th>${models
              .map((m) =>
                cell(
                  images.find(
                    (i) =>
                      i.model === m.model &&
                      i.label === m.label &&
                      i.prompt === p.id &&
                      i.seed === seed,
                  ),
                ),
              )
              .join('')}</tr>`,
        )
        .join('\n');
    })
    .join('\n');
  return `<!doctype html><meta charset="utf-8"><title>Image bench</title>
<style>body{font:13px system-ui;margin:16px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px;vertical-align:top;text-align:left}img{width:220px;display:block}th div,td div{font-weight:normal;color:#555;max-width:220px}.err{color:#a00;max-width:220px}</style>
<table><tr><th></th>${cols.map((c) => `<th>${c}</th>`).join('')}</tr>
${body}</table>`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cache = String(args.flags.cache ?? defaultCacheRoot());
  const label = String(args.flags.label ?? 'default');
  const suite = String(args.flags.suite ?? 'sanity');
  const prompts = resolveImageBenchPrompts(suite, list(args.flags.prompts));
  const rewrites =
    typeof args.flags['prompt-file'] === 'string'
      ? (JSON.parse(await readFile(args.flags['prompt-file'], 'utf8')) as Record<string, string>)
      : undefined;
  const seeds = (list(args.flags.seeds).length ? list(args.flags.seeds) : ['42']).map(Number);
  const sizeFlag =
    typeof args.flags.size === 'string' ? args.flags.size.match(/^(\d+)x(\d+)$/) : null;
  const size = sizeFlag ? { width: Number(sizeFlag[1]), height: Number(sizeFlag[2]) } : undefined;
  const steps = args.flags.steps ? Number(args.flags.steps) : undefined;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = resolve(
    String(args.flags['runs-dir'] ?? join(repoRoot(), 'evals', 'runs', `image-bench-${ts}`)),
  );
  await mkdir(outDir, { recursive: true });
  const hfCache = args.flags['no-align']
    ? undefined
    : String(args.flags['hf-cache'] ?? defaultHfCache() ?? '') || undefined;
  const judge: JudgeEndpoint | undefined =
    typeof args.flags['judge-url'] === 'string'
      ? {
          baseUrl: args.flags['judge-url'],
          model: String(args.flags['judge-model'] ?? 'judge'),
          ...(typeof args.flags['judge-key'] === 'string'
            ? { apiKey: args.flags['judge-key'] }
            : {}),
          ...(typeof args.flags['judge-body'] === 'string'
            ? { extraBody: JSON.parse(args.flags['judge-body']) as Record<string, unknown> }
            : {}),
        }
      : undefined;
  if (args.flags.rescore) {
    await rescore(outDir, {
      hfCache,
      judge,
      ...(args.flags['judge-max'] ? { judgeMax: Number(args.flags['judge-max']) } : {}),
    });
    console.log('[image-bench] rescored');
    return;
  }
  const sdBin =
    typeof args.flags['sd-bin'] === 'string' ? args.flags['sd-bin'] : resolveSdBinary()?.path;
  if (!sdBin) throw new Error('no sd-server binary: pass --sd-bin or fetch the native binaries');
  const sdLibDir =
    typeof args.flags['sd-lib-dir'] === 'string' ? args.flags['sd-lib-dir'] : undefined;
  const models = list(args.flags.models).length
    ? list(args.flags.models)
    : await cachedImageModels(cache);
  if (models.length === 0) throw new Error(`no sd-cpp models in ${cache}`);

  console.log(
    `[image-bench] ${models.length} model(s) × ${prompts.length} prompt(s) × ${seeds.length} seed(s), sd-server ${sdBin}, out ${outDir}`,
  );
  const allModels: ModelRecord[] = [];
  const allImages: ImageRecord[] = [];
  const lease = acquireEvalDeviceLock();
  try {
    for (const model of models) {
      const result = await runModel({
        model,
        label,
        cache,
        sdBin,
        ...(sdLibDir ? { sdLibDir } : {}),
        prompts,
        seeds,
        ...(size ? { size } : {}),
        ...(steps ? { steps } : {}),
        ...(rewrites ? { rewrites } : {}),
        outDir,
      });
      allModels.push(result.model);
      allImages.push(...result.images);
      await rm(join(outDir, 'homes', `${label}-${model}`), { recursive: true, force: true });
    }
  } finally {
    lease.release();
  }

  await scoreImages(outDir, allImages, prompts, { hfCache, judge });
  for (const image of allImages)
    await appendFile(join(outDir, 'images.jsonl'), `${JSON.stringify(image)}\n`);
  for (const model of allModels)
    await appendFile(join(outDir, 'models.jsonl'), `${JSON.stringify(model)}\n`);
  await writeReports(outDir, label, allModels, allImages, prompts);
  console.log('[image-bench] done');
}

async function scoreImages(
  outDir: string,
  images: ImageRecord[],
  prompts: ImageBenchPrompt[],
  opts: {
    hfCache: string | undefined;
    judge: JudgeEndpoint | undefined;
    /** Leave images that already carry a verdict alone, so an interrupted pass resumes. */
    keepJudged?: boolean;
    /** Called after each judged image, to save progress. */
    onJudged?: () => Promise<void>;
    /** Judge at most this many images, then stop (resume with another pass). */
    judgeMax?: number;
  },
): Promise<void> {
  if (opts.hfCache) {
    const scorer = await createAlignmentScorer({ hfCache: opts.hfCache, prompts });
    try {
      for (const image of images) {
        if (!image.file) continue;
        image.alignment = await scorer.score(
          await readFile(join(outDir, image.file)),
          image.prompt,
        );
      }
    } finally {
      await scorer.dispose();
    }
  }
  if (opts.judge) {
    let judged = 0;
    for (const image of images) {
      const prompt = prompts.find((p) => p.id === image.prompt);
      if (!image.file || !prompt || (opts.keepJudged && image.judge)) continue;
      if (opts.judgeMax !== undefined && judged >= opts.judgeMax) break;
      judged++;
      const png = await readFile(join(outDir, image.file));
      // One retry: a long unattended pass sees the odd dropped connection.
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          image.judge = await judgeImage(opts.judge, png, prompt);
          image.judgeError = undefined;
          break;
        } catch (err) {
          image.judgeError = err instanceof Error ? err.message : String(err);
        }
      }
      console.log(
        `[image-bench] judge ${image.label} ${image.model} ${image.prompt} s${image.seed}: ${image.judge ? `${image.judge.score} matches=${image.judge.matches}${image.judge.textCorrect === undefined ? '' : ` text=${image.judge.textCorrect}`}` : image.judgeError}`,
      );
      await opts.onJudged?.();
    }
  }
}

async function writeReports(
  outDir: string,
  label: string,
  models: ModelRecord[],
  images: ImageRecord[],
  prompts: ImageBenchPrompt[],
): Promise<void> {
  const table = reportMarkdown(models, images);
  await writeFile(join(outDir, `report-${label}.md`), table);
  await writeFile(join(outDir, `report-${label}.html`), reportHtml(models, images, prompts));
  console.log(`\n${table}`);
}

/** Re-score a finished run in place: every label it holds gets fresh reports. */
async function rescore(
  outDir: string,
  opts: { hfCache: string | undefined; judge: JudgeEndpoint | undefined; judgeMax?: number },
): Promise<void> {
  const read = async <T>(name: string) =>
    (await readFile(join(outDir, name), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as T);
  const images = await read<ImageRecord>('images.jsonl');
  const models = await read<ModelRecord>('models.jsonl');
  const prompts = IMAGE_BENCH_PROMPTS.filter((p) => images.some((i) => i.prompt === p.id));
  const save = () =>
    writeFile(join(outDir, 'images.jsonl'), images.map((i) => `${JSON.stringify(i)}\n`).join(''));
  await scoreImages(outDir, images, prompts, { ...opts, keepJudged: true, onJudged: save });
  await save();
  for (const label of new Set(models.map((m) => m.label))) {
    await writeReports(
      outDir,
      label,
      models.filter((m) => m.label === label),
      images.filter((i) => i.label === label),
      prompts,
    );
  }
}

await main();
