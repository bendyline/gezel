/**
 * `pnpm --filter @bendyline/gezel-evals run video-bench -- [flags]`
 *
 * Renders clips through every listed local video model the way a person's
 * request does: a fresh trial daemon per model, `POST /api/video-gen/generate`
 * with the prompt, model, seed and size, so the catalog's steps, guidance and
 * render settings and the engine's launch flags all apply. Records per clip
 * the wall time, the engine's own timings, the frames and size actually
 * delivered, model-free sanity flags (black, frozen), and the engine's peak
 * memory beside two estimates: the daemon's own fit at the default size and
 * core's size-aware price for the clip rendered. One `calibration.jsonl` line
 * per clip feeds the memory fit (`docs/media-model-memory.md`).
 *
 * Flags:
 *   --models <a,b>       catalog ids (required)
 *   --cache <home>       eval model cache (default ~/.gezel-eval-cache)
 *   --sd-bin <path>      sd-server (default: the staged native binary)
 *   --gilde-data <dir>   catalog content (default ../gilde/data beside the repo)
 *   --sizes <a,b>        WxHxF clips to render; `default` is the model's own (default "default")
 *   --seeds <a,b>        default 42
 *   --prompts <a,b>      prompt ids (default "waves")
 *   --image <path>       a picture to animate with every clip (image-to-video)
 *   --sd-cpp <json>      merged into each sd.cpp model's render settings for this run only
 *                        (the trial home's copy), e.g. '{"vaeTiling":{"temporal":true}}';
 *                        recorded on every calibration line as `sdCppOverride`
 *   --cooldown <s>       seconds to rest between clips, so heat does not skew timing (default 0)
 *   --runs-dir <path>    output (default evals/runs/video-bench-<ts>)
 *
 * Method and recorded runs: evals/src/video-bench/VIDEO-BENCH.md.
 */
import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { VIDEO_ARCHITECTURES, type VideoModelManifest, videoLatentTokens } from '@bendyline/gezel';
import { acquireEvalDeviceLock } from '../eval-device-lock.ts';
import { linkModelIntoTrial, modelDirInHome } from '../model-cache.ts';
import { repoRoot, resolveSdBinary } from '../native-bin.ts';
import { findTrialNativeChildren, shutdownTrialDaemon, spawnTrialDaemon } from '../spawn.ts';
import {
  type DiffusersVideoJob,
  type SdVideoJobBuffers,
  diffusersJobReport,
  jobPhaseBytes,
  parseDiffusersVideoLog,
  parseSdVideoLog,
} from '../video-bench/engine-log.ts';
import { type EnginePeak, EnginePeakWatch, type GpuPeakParts } from '../video-bench/peak.ts';
import { type ClipEstimate, type Placement, estimateClip } from '../video-bench/price.ts';
import { installedRenderSettings, snapshotTrialWeights } from '../video-bench/render-settings.ts';
import { parseArgs } from './args.ts';

const exec = promisify(execFile);
const GiB = 1024 ** 3;

const PROMPTS: Record<string, string> = {
  waves:
    'Ocean waves roll onto a sandy beach at golden hour, foam spreading across wet sand, the camera slowly tracking along the shoreline.',
  cat: 'A ginger cat on a sunlit windowsill turns its head and blinks slowly, dust drifting in the light, a close-up shot.',
  city: 'A rainy city street at night, neon signs reflecting in puddles as people with umbrellas walk past, a slow push in.',
};

interface Size {
  width: number;
  height: number;
  numFrames: number;
}

interface ClipRecord {
  model: string;
  engine?: string;
  prompt: string;
  seed: number;
  requested?: Size;
  rendered?: Size & { fps: number };
  wallSeconds?: number;
  artifactPath?: string;
  mimeType?: string;
  bytes?: number;
  posterPath?: string;
  notes?: string[];
  flags?: string[];
  probe?: { frames?: number; width?: number; height?: number; duration?: number; audio?: boolean };
  estimate?: ClipEstimate;
  /**
   * The clip's peak: the larger of the engine's lifetime footprint peak (each
   * clip's own when sizes ascend) and the most it held at one poll with Metal
   * buffers counted as the GPU driver holds them (video-bench/peak.ts).
   */
  measuredPeakBytes?: number;
  /** The lifetime footprint peak alone, which misses pages only the GPU touched. */
  footprintPeakBytes?: number;
  /** The polled peak with Metal buffers as the GPU driver holds them. */
  gpuPeakBytes?: number;
  /** What that poll read, to check it by hand. */
  gpuPeakParts?: GpuPeakParts;
  /** sd-server's own weights and per-graph compute buffers for this clip. */
  engineBuffers?: Omit<SdVideoJobBuffers, 'size'>;
  /** The diffusers engine's weights and per-phase device peaks for this clip. */
  diffusersTrace?: Omit<DiffusersVideoJob, 'size'>;
  error?: string;
}

interface ModelRecord {
  model: string;
  engine?: string;
  fit?: { verdict: string; bytes: number; weightBytes: number; pool: string };
  peak: EnginePeak;
  clips: number;
  failures: number;
  coldSeconds?: number;
  steadySeconds?: number;
  engineLines: string[];
}

function parseSize(spec: string): Size | 'default' {
  if (spec === 'default') return 'default';
  const m = /^(\d+)x(\d+)x(\d+)$/.exec(spec);
  if (!m) throw new Error(`--sizes entries are WxHxF or "default", got ${spec}`);
  return { width: Number(m[1]), height: Number(m[2]), numFrames: Number(m[3]) };
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Frames, size and sound as ffprobe reads them; undefined without ffprobe. */
async function probe(path: string): Promise<ClipRecord['probe']> {
  try {
    const { stdout } = await exec('ffprobe', [
      '-v',
      'error',
      '-count_frames',
      '-show_entries',
      'stream=codec_type,width,height,nb_read_frames:format=duration',
      '-of',
      'json',
      path,
    ]);
    const data = JSON.parse(stdout) as {
      streams?: Array<{
        codec_type?: string;
        width?: number;
        height?: number;
        nb_read_frames?: string;
      }>;
      format?: { duration?: string };
    };
    const video = data.streams?.find((s) => s.codec_type === 'video');
    return {
      ...(video?.nb_read_frames ? { frames: Number(video.nb_read_frames) } : {}),
      ...(video?.width ? { width: video.width, height: video.height } : {}),
      ...(data.format?.duration ? { duration: Number(data.format.duration) } : {}),
      audio: Boolean(data.streams?.some((s) => s.codec_type === 'audio')),
    };
  } catch {
    return undefined;
  }
}

/**
 * Model-free checks on 8 frames scaled to 32x18 grey: a black clip, and a
 * frozen one (consecutive frames nearly identical).
 */
async function sanityFlags(path: string, frames: number | undefined): Promise<string[]> {
  try {
    const step = Math.max(1, Math.floor((frames ?? 8) / 8));
    const { stdout } = await exec(
      'ffmpeg',
      [
        '-v',
        'error',
        '-i',
        path,
        '-vf',
        `select=not(mod(n\\,${step})),scale=32:18`,
        '-vsync',
        '0',
        '-frames:v',
        '8',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'gray',
        '-',
      ],
      { encoding: 'buffer', maxBuffer: 1024 * 1024 },
    );
    const buf = stdout as unknown as Buffer;
    const size = 32 * 18;
    const count = Math.floor(buf.length / size);
    if (count === 0) return ['undecodable'];
    const flags: string[] = [];
    let mean = 0;
    for (const v of buf.subarray(0, count * size)) mean += v;
    mean /= count * size * 255;
    if (mean < 0.03) flags.push('black');
    if (count > 1) {
      let diff = 0;
      for (let f = 1; f < count; f++) {
        for (let i = 0; i < size; i++) {
          diff += Math.abs((buf[f * size + i] as number) - (buf[(f - 1) * size + i] as number));
        }
      }
      if (diff / ((count - 1) * size * 255) < 0.003) flags.push('frozen');
    }
    return flags;
  } catch {
    return ['undecodable'];
  }
}

/**
 * Merges render settings into the trial home's installed manifest, which the
 * engine reads at render time. The trial copy is a clone of the cache's, so
 * the cache keeps the catalog's settings.
 */
async function overrideRenderSettings(
  manifestPath: string,
  override: Record<string, unknown>,
): Promise<void> {
  const installed = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    sdCpp?: Record<string, unknown>;
  };
  installed.sdCpp = mergeDeep(installed.sdCpp ?? {}, override);
  await rm(manifestPath);
  await writeFile(manifestPath, JSON.stringify(installed, null, 2));
}

function mergeDeep(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const prior = out[key];
    out[key] =
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      prior &&
      typeof prior === 'object'
        ? mergeDeep(prior as Record<string, unknown>, value as Record<string, unknown>)
        : value;
  }
  return out;
}

async function runModel(opts: {
  model: string;
  manifest: VideoModelManifest;
  cache: string;
  sdBin: string;
  gildeData: string;
  sizes: Array<Size | 'default'>;
  seeds: number[];
  prompts: string[];
  image?: { data: string; mimeType: string };
  sdCppOverride?: Record<string, unknown>;
  cooldownSeconds: number;
  outDir: string;
  calibrationPath: string;
}): Promise<{ record: ModelRecord; clips: ClipRecord[] }> {
  const { model, manifest, outDir } = opts;
  const modelDir = join(outDir, model);
  const home = join(outDir, 'homes', model);
  await rm(home, { recursive: true, force: true });
  await mkdir(modelDir, { recursive: true });
  await linkModelIntoTrial({
    cacheRoot: opts.cache,
    trialHome: home,
    engine: manifest.engine === 'sd-cpp' ? 'sd-cpp-video' : 'video',
    modelId: model,
  });
  const installedManifest = join(modelDirInHome(home, 'sd-cpp-video', model), 'manifest.json');
  if (opts.sdCppOverride && manifest.engine === 'sd-cpp') {
    await overrideRenderSettings(installedManifest, opts.sdCppOverride);
  }
  // What the engine renders with: the install record, not the catalog, which
  // may have moved on since the model was cached.
  const renderSettings =
    manifest.engine === 'sd-cpp' ? await installedRenderSettings(installedManifest) : undefined;
  const logPath = join(modelDir, 'daemon.log');
  const watch = new EnginePeakWatch(() => findTrialNativeChildren(home));
  const daemon = await spawnTrialDaemon({
    home,
    sdBin: opts.sdBin,
    stderrLogPath: logPath,
    extraEnv: {
      GEZEL_LOG_LEVEL: 'info',
      GEZEL_GILDE_DATA_DIR: opts.gildeData,
      // A private ledger: a render here must not make another session's evals wait.
      GEZEL_NATIVE_CAPACITY_DIR: join(home, 'native-capacity'),
      GEZEL_NATIVE_CAPACITY_AUTHORITY: 'local',
      GEZEL_MEDIA_MEMORY_TRACE: '1',
    },
  });
  const clips: ClipRecord[] = [];
  let fit: ModelRecord['fit'];
  let where: Placement = { backend: 'metal', pool: 'unified' };
  let peak: EnginePeak;
  try {
    await daemon.client.updateConfig({
      firstRunCompleted: true,
      defaultVideoModel: model,
      videoGenerationConfirmation: 'always-allow',
    });
    const fits = await daemon.client.getVideoModelFit().catch((err: unknown) => {
      console.error(`fit unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    });
    if (fits && !fits.models.some((m) => m.id === model)) {
      console.error(`fit lists no ${model} (${fits.models.map((m) => m.id).join(', ')})`);
    }
    const own = fits?.models.find((m) => m.id === model);
    if (own)
      fit = {
        verdict: own.verdict,
        bytes: own.bytes,
        weightBytes: own.weightBytes,
        pool: own.pool,
      };
    const status = await daemon.client.getVideoEngineStatus().catch(() => undefined);
    const backend =
      status?.engine.engines?.find((e) => e.engine === manifest.engine)?.backend ??
      (process.platform === 'darwin' ? 'metal' : 'cpu');
    where = { backend, pool: own?.pool ?? 'unified' };
    await watch.begin();
    for (const spec of opts.sizes) {
      for (const promptId of opts.prompts) {
        for (const seed of opts.seeds) {
          const size =
            spec === 'default'
              ? {
                  width: manifest.defaultWidth ?? 832,
                  height: manifest.defaultHeight ?? 480,
                  numFrames: manifest.defaultNumFrames,
                }
              : spec;
          const clip: ClipRecord = {
            model,
            prompt: promptId,
            seed,
            requested: size,
            estimate: estimateClip(
              manifest,
              size,
              where,
              Boolean(opts.image) && manifest.supportsImageToVideo === true,
            ),
          };
          const started = Date.now();
          try {
            const res = await daemon.client.generateVideo({
              prompt: PROMPTS[promptId] ?? promptId,
              model,
              seed,
              width: size.width,
              height: size.height,
              numFrames: size.numFrames,
              projectId: 'default',
              ...(opts.image ? { inputImage: opts.image, requireImageToVideo: true } : {}),
            });
            clip.wallSeconds = (Date.now() - started) / 1000;
            const m = res.meta;
            clip.engine = m.engine;
            clip.rendered = {
              width: m.widthPx,
              height: m.heightPx,
              numFrames: m.numFrames,
              fps: m.fps,
            };
            clip.artifactPath = res.artifactPath;
            clip.mimeType = m.mimeType;
            if (res.posterPath) clip.posterPath = res.posterPath;
            if (m.settingsNotes?.length) clip.notes = m.settingsNotes;
            const blob = await daemon.client.fetchProjectArtifactBlob('default', res.artifactPath);
            const bytes = Buffer.from(await blob.arrayBuffer());
            clip.bytes = bytes.length;
            const ext = m.mimeType.includes('webm') ? 'webm' : 'mp4';
            const file = join(
              modelDir,
              `${promptId}-${seed}-${size.width}x${size.height}x${size.numFrames}.${ext}`,
            );
            await writeFile(file, bytes);
            clip.probe = await probe(file);
            clip.flags = await sanityFlags(file, clip.probe?.frames);
          } catch (err) {
            clip.wallSeconds = (Date.now() - started) / 1000;
            clip.error = err instanceof Error ? err.message : String(err);
          }
          // The engine's lifetime peak is read while it is still running.
          const peakNow = await watch.clipPeak();
          if (peakNow) {
            clip.measuredPeakBytes = peakNow.bytes;
            clip.footprintPeakBytes = peakNow.footprintBytes;
            if (peakNow.gpuBytes !== undefined) clip.gpuPeakBytes = peakNow.gpuBytes;
            if (peakNow.gpuParts) clip.gpuPeakParts = peakNow.gpuParts;
          }
          clips.push(clip);
          await appendFile(join(outDir, 'renders.jsonl'), `${JSON.stringify(clip)}\n`);
          console.error(
            `${model} ${promptId} seed=${seed} ${size.width}x${size.height}x${size.numFrames}: ${
              clip.error
                ? `FAILED ${clip.error}`
                : `${clip.wallSeconds?.toFixed(0)}s ${clip.flags?.join(',') || 'ok'}`
            }`,
          );
          if (opts.cooldownSeconds > 0)
            await new Promise((r) => setTimeout(r, opts.cooldownSeconds * 1000));
        }
      }
    }
  } finally {
    await watch.sample();
    peak = await watch.end();
    await shutdownTrialDaemon(daemon);
  }
  const logText = await readFile(logPath, 'utf8').catch(() => '');
  const jobs = parseSdVideoLog(logText);
  for (const c of clips) {
    if (c.error || !c.rendered) continue;
    const { width, height, numFrames } = c.rendered;
    const at = jobs.findIndex(
      (j) => j.size.width === width && j.size.height === height && j.size.numFrames === numFrames,
    );
    if (at < 0) continue;
    const { size: _size, ...buffers } = jobs.splice(at, 1)[0] as SdVideoJobBuffers;
    c.engineBuffers = buffers;
  }
  const traced = parseDiffusersVideoLog(logText).filter((j) => j.completed);
  for (const c of clips) {
    if (c.error || !c.rendered || c.engineBuffers) continue;
    const { width, height, numFrames } = c.rendered;
    const at = traced.findIndex(
      (j) => j.size.width === width && j.size.height === height && j.size.numFrames === numFrames,
    );
    if (at < 0) continue;
    const { size: _size, ...trace } = traced.splice(at, 1)[0] as DiffusersVideoJob;
    c.diffusersTrace = trace;
  }
  const engineLines = logText
    .split('\n')
    .filter((l) =>
      /\[(sd-video-server|video-server)\].*(generate_video|params memory|completed in|out of memory|retrying|memory (job|phase|components|versions))/i.test(
        l,
      ),
    )
    .slice(-40);
  const ok = clips.filter((c) => !c.error);
  const record: ModelRecord = {
    model,
    ...(ok[0]?.engine ? { engine: ok[0].engine } : {}),
    ...(fit ? { fit } : {}),
    peak,
    clips: ok.length,
    failures: clips.length - ok.length,
    ...(ok[0]?.wallSeconds !== undefined ? { coldSeconds: ok[0].wallSeconds } : {}),
    ...(ok.length > 1 ? { steadySeconds: median(ok.slice(1).map((c) => c.wallSeconds ?? 0)) } : {}),
    engineLines,
  };
  await writeFile(join(modelDir, 'model.json'), JSON.stringify(record, null, 2));
  // One clip per line, for the memory fit. The peak is the run's: one engine
  // serves every clip, so a calibration run renders one size per model run.
  const geometry = manifest.architecture ? VIDEO_ARCHITECTURES[manifest.architecture] : undefined;
  for (const c of ok) {
    await appendFile(
      opts.calibrationPath,
      `${JSON.stringify({
        at: new Date().toISOString(),
        host: process.platform,
        engine: c.engine,
        backend: where.backend,
        pool: where.pool,
        model,
        architecture: manifest.architecture,
        size: c.rendered,
        ...(geometry && c.rendered
          ? {
              latentTokens: videoLatentTokens(geometry, c.rendered),
              hiddenSize: geometry.hiddenSize,
            }
          : {}),
        // sd-server runs guided and unguided passes in turn; diffusers batches them.
        batch: manifest.engine !== 'sd-cpp' && (manifest.guidanceScale ?? 1) > 1 ? 2 : 1,
        estimateBytes: c.estimate?.bytes,
        weightBytes: c.estimate?.weightBytes,
        measuredPeakBytes: c.measuredPeakBytes ?? peak.processPeakBytes,
        ...(c.footprintPeakBytes !== undefined ? { footprintPeakBytes: c.footprintPeakBytes } : {}),
        ...(c.gpuPeakBytes !== undefined ? { gpuPeakBytes: c.gpuPeakBytes } : {}),
        ...(c.gpuPeakParts ? { gpuPeakParts: c.gpuPeakParts } : {}),
        source: c.gpuPeakBytes !== undefined ? 'footprint+gpu' : peak.source,
        ...(renderSettings ? { renderSettings } : {}),
        ...(opts.image && manifest.supportsImageToVideo ? { animatesPicture: true } : {}),
        ...(opts.sdCppOverride ? { sdCppOverride: opts.sdCppOverride } : {}),
        ...(c.engineBuffers
          ? {
              engineReported: c.engineBuffers,
              phases: jobPhaseBytes(c.engineBuffers.buffers),
            }
          : c.diffusersTrace
            ? diffusersJobReport(c.diffusersTrace)
            : {}),
      })}\n`,
    );
  }
  return { record, clips };
}

/** Weights plus the largest graph, as sd-server reported them: `7.1 + 4.3 (Wan2.2-TI2V-5B)`. */
function engineSummary(
  engine: ClipRecord['engineBuffers'],
  trace?: ClipRecord['diffusersTrace'],
): string {
  if (!engine && trace) {
    const { engineReported, phases } = diffusersJobReport(trace);
    const [phase, bytes] = Object.entries(phases).reduce((a, b) => (b[1] > a[1] ? b : a));
    return `${(engineReported.paramsBytes / GiB).toFixed(1)} + ${(bytes / GiB).toFixed(1)} (${phase})`;
  }
  if (!engine) return '—';
  const largest = Object.entries(engine.buffers)
    .map(([name, b]) => ({ name, bytes: b.vramBytes + b.ramBytes }))
    .reduce<{ name: string; bytes: number } | undefined>(
      (a, b) => (!a || b.bytes > a.bytes ? b : a),
      undefined,
    );
  const weights = engine.paramsBytes !== undefined ? (engine.paramsBytes / GiB).toFixed(1) : '?';
  return largest ? `${weights} + ${(largest.bytes / GiB).toFixed(1)} (${largest.name})` : weights;
}

function report(models: ModelRecord[], clips: ClipRecord[]): string {
  const gb = (b?: number | null) => (b ? (b / GiB).toFixed(1) : '—');
  const lines = [
    '# Video bench',
    '',
    '| model | engine | clips | cold s | steady s | peak GB | fit GB (default) | verdict |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...models.map(
      (m) =>
        `| ${m.model} | ${m.engine ?? '—'} | ${m.clips}/${m.clips + m.failures} | ${m.coldSeconds?.toFixed(0) ?? '—'} | ${m.steadySeconds?.toFixed(0) ?? '—'} | ${gb(Math.max(m.peak.processPeakBytes ?? 0, m.peak.gpuSampledBytes ?? 0))} | ${gb(m.fit?.bytes)} | ${m.fit?.verdict ?? '—'} |`,
    ),
    '',
    '| model | prompt | seed | rendered | s | est GB | peak GB | engine GB | frames (probe) | flags | notes |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...clips.map((c) =>
      c.error
        ? `| ${c.model} | ${c.prompt} | ${c.seed} | — | ${c.wallSeconds?.toFixed(0) ?? '—'} | ${gb(c.estimate?.bytes)} | ${gb(c.measuredPeakBytes)} | — | — | FAILED: ${c.error.slice(0, 120)} | |`
        : `| ${c.model} | ${c.prompt} | ${c.seed} | ${c.rendered?.width}x${c.rendered?.height}x${c.rendered?.numFrames}@${c.rendered?.fps} | ${c.wallSeconds?.toFixed(0)} | ${gb(c.estimate?.bytes)} | ${gb(c.measuredPeakBytes)} | ${engineSummary(c.engineBuffers, c.diffusersTrace)} | ${c.probe?.frames ?? '—'}${c.probe?.audio ? ' +audio' : ''} | ${c.flags?.join(', ') || 'ok'} | ${(c.notes ?? []).join(' ')} |`,
    ),
    '',
  ];
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const flag = (name: string) =>
    typeof args.flags[name] === 'string' ? (args.flags[name] as string) : undefined;
  const models = (flag('models') ?? '').split(',').filter(Boolean);
  if (models.length === 0) throw new Error('--models is required');
  const cache = resolve(flag('cache') ?? join(homedir(), '.gezel-eval-cache'));
  const gildeData = resolve(flag('gilde-data') ?? join(repoRoot(), '..', 'gilde', 'data'));
  const sdBin = flag('sd-bin') ?? resolveSdBinary()?.path;
  if (!sdBin) throw new Error('no sd-server binary; pass --sd-bin');
  const sizes = (flag('sizes') ?? 'default').split(',').map(parseSize);
  const seeds = (flag('seeds') ?? '42').split(',').map(Number);
  const prompts = (flag('prompts') ?? 'waves').split(',');
  const imagePath = flag('image');
  const image = imagePath
    ? {
        data: (await readFile(imagePath)).toString('base64'),
        mimeType:
          imagePath.toLowerCase().endsWith('.jpg') || imagePath.toLowerCase().endsWith('.jpeg')
            ? 'image/jpeg'
            : 'image/png',
      }
    : undefined;
  const outDir = resolve(
    flag('runs-dir') ??
      join(
        repoRoot(),
        'evals',
        'runs',
        `video-bench-${new Date().toISOString().replace(/[:.]/g, '-')}`,
      ),
  );
  await mkdir(outDir, { recursive: true });
  const { CatalogService } = await import('@bendyline/gezel-catalog');
  process.env.GEZEL_GILDE_DATA_DIR = gildeData;
  const catalog = new CatalogService();
  const lease = acquireEvalDeviceLock();
  const records: ModelRecord[] = [];
  const allClips: ClipRecord[] = [];
  try {
    for (const model of models) {
      const detail = await catalog.get('video-model', model);
      if (!detail || detail.manifest.kind !== 'video-model')
        throw new Error(`${model} is not a catalog video model`);
      const { record, clips } = await runModel({
        model,
        manifest: detail.manifest,
        cache,
        sdBin,
        gildeData,
        sizes,
        seeds,
        prompts,
        ...(image ? { image } : {}),
        ...(flag('sd-cpp') ? { sdCppOverride: JSON.parse(flag('sd-cpp') as string) } : {}),
        cooldownSeconds: Number(flag('cooldown') ?? 0),
        outDir,
        calibrationPath: join(outDir, 'calibration.jsonl'),
      });
      records.push(record);
      allClips.push(...clips);
      // What the engine loaded, so the trial home's weight copies can go.
      await snapshotTrialWeights(outDir);
      await writeFile(join(outDir, 'report.md'), report(records, allClips));
    }
  } finally {
    lease.release();
  }
  console.log(join(outDir, 'report.md'));
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
