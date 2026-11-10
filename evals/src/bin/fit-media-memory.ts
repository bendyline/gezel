/**
 * `pnpm --filter @bendyline/gezel-evals run fit-media-memory -- <runs dir>... [--gilde-data <dir>] [--reprice] [--write-fixture <file>]`
 *
 * Reads video-bench calibration lines and prints the fitted coefficients and
 * each clip against its estimate (src/video-bench/fit.ts). Read-only: change
 * the constants in packages/core/src/media-memory-coefficients.ts by hand.
 *
 * Lines written before the bench recorded them get the engine's own buffers
 * from the run's `<model>/daemon.log`, and their latent tokens, hidden width
 * and guidance batch from core's geometry and the catalog entry. `--reprice`
 * replaces each recorded estimate with what core charges now, to check the
 * current coefficients against every measured clip. `--write-fixture` writes
 * the clips whose peak counted GPU-held memory (`source: footprint+gpu`), each
 * with the weight files and model fields its engine loaded (read from the
 * run's trial home), for core's calibration test
 * (packages/core/src/__fixtures__/media-memory/).
 */
import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  type MediaBackend,
  type MediaMemoryPool,
  VIDEO_ARCHITECTURES,
  type VideoArchitecture,
  type VideoModelManifest,
  videoLatentTokens,
} from '@bendyline/gezel';
import { repoRoot } from '../native-bin.ts';
import { jobPhaseBytes, parseSdVideoLog } from '../video-bench/engine-log.ts';
import { type CalibrationLine, fitGroups, renderFit } from '../video-bench/fit.ts';
import { estimateClip, manifestWeightFiles } from '../video-bench/price.ts';
import {
  installedRenderSettings,
  readTrialInstall,
  trialInstallRecord,
  trialWeightFiles,
} from '../video-bench/render-settings.ts';
import { parseArgs } from './args.ts';

type Manifests = (id: string) => Promise<VideoModelManifest | undefined>;

async function readRun(
  path: string,
  manifest: Manifests,
  reprice: boolean,
): Promise<CalibrationLine[]> {
  const file = (await stat(path)).isDirectory() ? join(path, 'calibration.jsonl') : path;
  const lines = (await readFile(file, 'utf8'))
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as CalibrationLine);
  const jobsByModel = new Map<string, ReturnType<typeof parseSdVideoLog>>();
  for (const line of lines) {
    const arch = line.architecture as VideoArchitecture | undefined;
    if (arch && line.size && line.latentTokens === undefined) {
      line.latentTokens = videoLatentTokens(VIDEO_ARCHITECTURES[arch], line.size);
      line.hiddenSize = VIDEO_ARCHITECTURES[arch].hiddenSize;
    }
    // sd-server runs guided and unguided passes in turn, so its buffer is one
    // pass; lines written before 2026-11-10 counted guidance as a batch of 2.
    if (line.engine === 'sd-cpp') line.batch = 1;
    else if (line.batch === undefined) {
      const guidance = (await manifest(line.model))?.guidanceScale ?? 1;
      line.batch = guidance > 1 ? 2 : 1;
    }
    line.runDir = dirname(file);
    if (line.backend === undefined && line.host === 'darwin') line.backend = 'metal';
    if (line.animatesPicture === undefined && line.size) {
      const generations = await renderedFromPicture(join(dirname(file), line.model, 'daemon.log'));
      if (generations.has(clipKey(line.size))) line.animatesPicture = true;
    }
    if (line.engine === 'sd-cpp' && line.renderSettings === undefined) {
      const settings = await installedRenderSettings(trialInstallRecord(dirname(file), line.model));
      if (settings) line.renderSettings = settings;
    }
    const catalogEntry = reprice && line.size ? await manifest(line.model) : undefined;
    // Price what the engine ran: its install record's settings, not the catalog's now.
    const entry =
      catalogEntry && line.renderSettings
        ? ({ ...catalogEntry, sdCpp: line.renderSettings } as VideoModelManifest)
        : catalogEntry;
    if (entry && line.size && line.backend) {
      const now = estimateClip(
        entry,
        line.size,
        {
          backend: line.backend as MediaBackend,
          pool: (line.pool as MediaMemoryPool | undefined) ?? 'unified',
        },
        line.animatesPicture === true,
      );
      line.estimateBytes = now.bytes;
      line.weightBytes = now.weightBytes;
    }
    if (line.engineReported || !line.size) continue;
    if (!jobsByModel.has(line.model)) {
      const log = await readFile(join(dirname(file), line.model, 'daemon.log'), 'utf8').catch(
        () => '',
      );
      jobsByModel.set(line.model, parseSdVideoLog(log));
    }
    const jobs = jobsByModel.get(line.model) ?? [];
    const { width, height, numFrames } = line.size;
    const at = jobs.findIndex(
      (j) => j.size.width === width && j.size.height === height && j.size.numFrames === numFrames,
    );
    if (at < 0) continue;
    const job = jobs.splice(at, 1)[0];
    if (!job) continue;
    line.engineReported = job.paramsBytes !== undefined ? { paramsBytes: job.paramsBytes } : {};
    line.phases = jobPhaseBytes(job.buffers);
  }
  return lines;
}

const clipKey = (size: { width: number; height: number; numFrames: number }) =>
  `${size.width}x${size.height}x${size.numFrames}`;

/**
 * The clips a run rendered from a picture, by size, for lines written before
 * the bench recorded it: the daemon logs `generate … frames=F … size=WxH i2v=true`.
 */
async function renderedFromPicture(logPath: string): Promise<Set<string>> {
  const log = await readFile(logPath, 'utf8').catch(() => '');
  const found = new Set<string>();
  for (const m of log.matchAll(
    /generate engine=\S+ model=\S+ .*?frames=(\d+) .*?size=(\d+)x(\d+) i2v=true/g,
  )) {
    found.add(clipKey({ width: Number(m[2]), height: Number(m[3]), numFrames: Number(m[1]) }));
  }
  return found;
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (positional.length === 0) {
    throw new Error('name one or more runs dirs or calibration.jsonl files');
  }
  const gildeData = resolve(
    typeof flags['gilde-data'] === 'string'
      ? flags['gilde-data']
      : join(repoRoot(), '..', 'gilde', 'data'),
  );
  process.env.GEZEL_GILDE_DATA_DIR = gildeData;
  const { CatalogService } = await import('@bendyline/gezel-catalog');
  const catalog = new CatalogService();
  const manifest: Manifests = async (id) => {
    const detail = await catalog.get('video-model', id).catch(() => undefined);
    return detail?.manifest.kind === 'video-model' ? detail.manifest : undefined;
  };
  const reprice = flags.reprice === true;
  const lines = (
    await Promise.all(positional.map((p) => readRun(resolve(p), manifest, reprice)))
  ).flat();
  process.stdout.write(`${renderFit(fitGroups(lines))}\n`);
  if (typeof flags['write-fixture'] === 'string') {
    const path = resolve(flags['write-fixture']);
    await writeFile(path, `${JSON.stringify(await fixtureOf(lines, manifest), null, 2)}\n`);
    process.stderr.write(`wrote ${path}\n`);
  }
}

/**
 * The clips whose peak counted GPU-held memory, with what core needs to price
 * each: the catalog's files as the estimator sees them, the manifest fields
 * `sdCppVideoModelRequirement` reads, and per clip the render settings the
 * engine actually ran with (a `--sd-cpp` override, or a catalog since changed).
 */
async function fixtureOf(lines: CalibrationLine[], manifest: Manifests) {
  const measured = lines.filter(
    (l) => l.source === 'footprint+gpu' && l.size && l.measuredPeakBytes,
  );
  const clips = [];
  for (const l of measured) {
    const priced = await pricedAsRun(l, manifest);
    if (!priced) {
      process.stderr.write(
        `skipped ${l.model} in ${l.runDir}: no install record or catalog entry\n`,
      );
      continue;
    }
    clips.push({
      model: l.model,
      backend: l.backend,
      pool: l.pool,
      size: { width: l.size?.width, height: l.size?.height, numFrames: l.size?.numFrames },
      measuredPeakBytes: l.measuredPeakBytes,
      ...priced,
      ...(l.animatesPicture ? { animatesPicture: true } : {}),
      ...(l.engineReported?.paramsBytes ? { engineParamsBytes: l.engineReported.paramsBytes } : {}),
      ...(l.phases ? { enginePhases: l.phases } : {}),
    });
  }
  return { clips };
}

/**
 * The files and model fields core prices a clip from, as the run's engine
 * loaded them: its trial home's install record and weight files. The catalog
 * entry stands in only when the trial home is gone, since an entry can change
 * its files or leave the catalog after the run.
 */
async function pricedAsRun(line: CalibrationLine, manifest: Manifests) {
  const install = line.runDir ? await readTrialInstall(line.runDir, line.model) : undefined;
  const files = line.runDir ? await trialWeightFiles(line.runDir, line.model) : undefined;
  if (install && files) {
    return {
      files,
      priced: {
        family: install.family,
        architecture: install.architecture,
        sdCpp: install.sdCpp,
        guidanceScale: install.guidanceScale,
        defaultWidth: install.defaultWidth,
        defaultHeight: install.defaultHeight,
        defaultNumFrames: install.defaultNumFrames,
      },
    };
  }
  const m = await manifest(line.model);
  if (!m) return undefined;
  return {
    files: manifestWeightFiles(m),
    priced: {
      family: m.family,
      architecture: m.architecture,
      sdCpp: line.renderSettings ?? m.sdCpp,
      guidanceScale: m.guidanceScale,
      defaultWidth: m.defaultWidth,
      defaultHeight: m.defaultHeight,
      defaultNumFrames: m.defaultNumFrames,
    },
  };
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
