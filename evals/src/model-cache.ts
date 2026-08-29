import { execFile } from 'node:child_process';
import { constants, existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { chatModelInstallIdentity } from './model-sources.ts';
import { shutdownTrialDaemon, spawnTrialDaemon } from './spawn.ts';

/**
 * Verify an MLX model directory is a *complete* install before the runner
 * symlinks it into a trial home.
 *
 * The directory merely existing is not enough. An interrupted download
 * leaves `<file>.partial` placeholders and never writes the `manifest.json`
 * install marker; the MLX engine then rejects the model ~6 ms into the first
 * chat turn ("the selected model … is not installed"), but the poll loop only
 * surfaces that 300 s later as a `chat-stalled` soft-timeout — a five-minute
 * mystery for a knowable, instant condition. Failing fast here turns it into
 * an actionable error naming the model and the fix.
 *
 * Wild-caught (first MLX eval sweep): `gemma4-12b-q4` and
 * `gemma4-12b-q8` sat in `~/.gezel-dev` as all-`.partial`, manifest-less
 * dirs from a stalled download, and burned a 301 s trial each before this.
 */
export function assertMlxSourceComplete(sourceDir: string, modelId: string): void {
  if (!existsSync(sourceDir)) {
    throw new Error(
      `MLX model not found at ${sourceDir}. Install ${modelId} via the app first, or pass --mlx-source-home <path>.`,
    );
  }
  let entries: string[];
  try {
    entries = readdirSync(sourceDir);
  } catch (err) {
    throw new Error(`MLX model dir ${sourceDir} is unreadable: ${String(err)}`);
  }
  const partials = entries.filter((e) => e.endsWith('.partial'));
  const hasManifest = entries.includes('manifest.json');
  const hasWeights = entries.some((e) => e.endsWith('.safetensors'));
  if (partials.length === 0 && hasManifest && hasWeights) return;

  const reasons: string[] = [];
  if (partials.length > 0) reasons.push(`${partials.length} unfinished .partial file(s)`);
  if (!hasManifest) reasons.push('no manifest.json install marker');
  if (!hasWeights) reasons.push('no .safetensors weights');
  throw new Error(
    `MLX model "${modelId}" at ${sourceDir} looks like an incomplete download (${reasons.join(', ')}). Re-download it via the app (delete the dir first to clear partials), then re-run.`,
  );
}

/**
 * If `path` is a symlink/junction whose target doesn't exist, remove it.
 * No-op when the path doesn't exist or resolves to a real file/directory.
 *
 * Reason this exists: a previous gezel-dev install can leave the
 * eval-cache pointing at `~/.gezel-dev/engines/<engine>/models/<id>`
 * via a junction. If the dev cache later gets nuked (or the user
 * switches machines / wipes that tree), the eval cache still has the
 * dangling link — `existsSync(manifestPath)` returns false (good), but
 * the install endpoint then tries to write *through* the broken link
 * and the post-install verification fails with "no valid
 * manifest+weights." Heal it pre-install.
 */
async function removeIfDangling(path: string): Promise<void> {
  let lst: ReturnType<typeof lstatSync>;
  try {
    lst = lstatSync(path);
  } catch {
    return;
  }
  if (!lst.isSymbolicLink()) return;
  try {
    statSync(path);
    return;
  } catch {
    // Symlink target doesn't exist — drop the link so the install can
    // write a fresh directory in its place.
    await rm(path, { force: true });
  }
}

/**
 * Remove `*.partial` files left in `dir` by an earlier interrupted/stalled
 * download. The SDXL warm stalled mid-stream, the cache writer
 * logged `install done` on a dead stream, and a 1.4 GB
 * `sd_xl_base_1.0.safetensors.partial` froze in the cache for 10 days
 * blocking every subsequent petshop trial. The install endpoint sees the
 * partial on retry, declines to overwrite it (or resumes incorrectly), and
 * each fresh trial re-hits the same poisoned state. Wiping the partial
 * pre-install forces a clean download.
 *
 * No-op when the directory doesn't exist or contains no partials.
 */
async function purgeStalePartials(dir: string, log: (line: string) => void): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.endsWith('.partial')) continue;
    const path = join(dir, name);
    try {
      const size = statSync(path).size;
      await rm(path, { force: true });
      log(`[cache] removed stale partial ${name} (${size} bytes) — forcing fresh download`);
    } catch {
      // Best-effort; if rm fails the install will throw downstream and
      // surface the actionable reason.
    }
  }
}

export type EngineKey = 'llama-cpp' | 'sd-cpp' | 'mlx';

/**
 * Default warm-cache root. Lives outside `~/.gezel` so a clean install of
 * gezel doesn't accidentally inherit eval-only state, and outside the repo
 * so a `git clean -fdx` doesn't nuke a 6 GB model.
 */
export function defaultCacheRoot(): string {
  return join(homedir(), '.gezel-eval-cache');
}

function modelDirInHome(home: string, engine: EngineKey, modelId: string): string {
  return join(home, 'engines', engine, 'models', modelId);
}

/**
 * Catalog ids were made quantization-explicit after some eval/app caches
 * already held the exact same weights under shorter ids. Keep this bridge
 * deliberately narrow: these are historical renames of the same shipped
 * variant, not fuzzy family matches (a q4 install must never satisfy q8).
 *
 * `gemma4-e2b`/`gemma4-e4b` are deliberately absent. Those short ids name
 * the Q8_0 weights the catalog shipped before the QAT-Q4 swap, so aliasing
 * them onto `gemma4-e{2,4}b-q4` would hand a cached Q8 tree to a Q4 id —
 * the same variant confusion this list exists to prevent.
 */
const HISTORICAL_LLAMA_CPP_ALIASES: Readonly<Record<string, string>> = {
  'deepseek-r1-8b-q4': 'deepseek-r1',
  'gemma4-26b-q4': 'gemma4-26b',
  'gemma4-31b-q4': 'gemma4-31b',
  'gpt-oss-20b-q4': 'gpt-oss',
  'llama3.2-3b-q4': 'llama3.2',
  'mistral-7b-q4': 'mistral',
  'mistral-medium-3.5-128b-q4': 'mistral-medium-3.5',
  'nemotron3-nano-30b-q4': 'nemotron3-nano-30b',
  'nemotron3-super-120b-q4': 'nemotron3-super-120b',
  'qwen3.5-2b-q4': 'qwen3.5-2b',
  'qwen3.5-4b-q4': 'qwen3.5-4b',
  'qwen3.5-9b-q4': 'qwen3.5-9b',
  'qwen3.6-27b-q4': 'qwen3.6',
};

/**
 * A model counts as installed when `manifest.json` is present, valid, and
 * names a `weightsFilename` that exists on disk. This matches the contract
 * both `LlamaCppModelManager.loadInstalled` and the sd-cpp provider's
 * loader enforce — same disk shape, same atomicity guarantee.
 */
export async function isModelInstalled(
  home: string,
  engine: EngineKey,
  modelId: string,
): Promise<boolean> {
  const dir = modelDirInHome(home, engine, modelId);
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) return false;
  try {
    const raw = await readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as { weightsFilename?: string };
    if (!parsed.weightsFilename) return false;
    return existsSync(join(dir, parsed.weightsFilename));
  } catch {
    return false;
  }
}

/**
 * Why a present-and-complete install no longer matches the catalog, or
 * `null` when it does (or when there's nothing to compare against).
 *
 * `isModelInstalled` deliberately answers only "is this a complete install"
 * — the same contract the service-side loaders enforce. That made warm
 * silently *sticky*: once a model was on disk it was never reconsidered, so
 * a catalog bump that repointed at new upstream weights left every eval
 * running the old ones. Wild-caught on 2026-07-29: all six warm llama-cpp
 * models sat at catalogVersion 1.1.0/1.2.0 against a catalog on
 * 1.1.2/1.1.4/1.2.1, two of them pointing at repos the catalog had moved off
 * (`lmstudio-community/Qwen3.6-27B-GGUF` → `unsloth/Qwen3.6-27B-MTP-GGUF`),
 * and three missing MTP draft weights added since. A whole model-vs-model
 * sweep would have measured pre-update weights and reported "no regressions".
 *
 * Ordered most-precise-first so the logged reason names the real difference.
 */
export async function staleInstallReason(opts: {
  cacheRoot: string;
  engine: EngineKey;
  /** Directory id to inspect on disk. */
  modelId: string;
  /**
   * Catalog id whose identity the install must match. Defaults to `modelId`;
   * pass the current id when inspecting a *historical* directory, whose own
   * slug is no longer in the catalog index.
   */
  expectedId?: string;
}): Promise<string | null> {
  // sd-cpp image models aren't in the chat-model index; nothing to check.
  if (opts.engine === 'sd-cpp') return null;
  const expected = chatModelInstallIdentity(opts.expectedId ?? opts.modelId, opts.engine);
  if (!expected) return null;

  const dir = modelDirInHome(opts.cacheRoot, opts.engine, opts.modelId);
  let installed: {
    catalogVersion?: string;
    sha256?: string;
    huggingfaceRepo?: string;
    weightsFilename?: string;
  };
  try {
    installed = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  } catch {
    // Unreadable manifest is "not installed", not "stale" — let
    // isModelInstalled reject it and the normal install path rebuild.
    return null;
  }

  if (expected.sha256 && installed.sha256 && expected.sha256 !== installed.sha256) {
    return `weights sha256 ${installed.sha256.slice(0, 12)}… != catalog ${expected.sha256.slice(0, 12)}…`;
  }
  if (
    expected.huggingfaceRepo &&
    installed.huggingfaceRepo &&
    expected.huggingfaceRepo !== installed.huggingfaceRepo
  ) {
    return `upstream repo moved: ${installed.huggingfaceRepo} -> ${expected.huggingfaceRepo}`;
  }
  if (
    expected.weightsFilename &&
    installed.weightsFilename &&
    expected.weightsFilename !== installed.weightsFilename
  ) {
    return `weights file ${installed.weightsFilename} != catalog ${expected.weightsFilename}`;
  }
  // Compare the draft by BASENAME. The catalog names it by its upstream
  // repo-relative path (`MTP/mtp-gemma-4-26B-A4B-it-Q4_0.gguf`) but the
  // install pipeline flattens it into the model dir, so a full-path check
  // never finds a correctly-installed draft — and would report a
  // just-downloaded model stale, re-evicting and refetching it every run.
  if (expected.draftFilename && !existsSync(join(dir, basename(expected.draftFilename)))) {
    return `missing draft (MTP) weights ${basename(expected.draftFilename)} added by catalog`;
  }
  if (
    expected.catalogVersion &&
    installed.catalogVersion &&
    expected.catalogVersion !== installed.catalogVersion
  ) {
    return `catalogVersion ${installed.catalogVersion} != catalog ${expected.catalogVersion}`;
  }
  return null;
}

/**
 * Reuse a complete historical-id install for its current catalog id. This
 * avoids downloading a second multi-GB copy solely because the directory
 * slug gained an explicit quantization suffix. A stale/incomplete target is
 * removed only after the legacy source has passed the normal manifest +
 * weights completeness check.
 */
export async function adoptHistoricalLlamaCppAlias(opts: {
  cacheRoot: string;
  modelId: string;
  log: (line: string) => void;
}): Promise<boolean> {
  const legacyId = HISTORICAL_LLAMA_CPP_ALIASES[opts.modelId];
  if (!legacyId) return false;
  if (!(await isModelInstalled(opts.cacheRoot, 'llama-cpp', legacyId))) return false;
  // The legacy dir holds the same *variant*, not necessarily the same
  // *revision*. Adopting a stale one would reintroduce the staleness the
  // caller just evicted, one id removed and harder to spot.
  const legacyStale = await staleInstallReason({
    cacheRoot: opts.cacheRoot,
    engine: 'llama-cpp',
    modelId: legacyId,
    expectedId: opts.modelId,
  });
  if (legacyStale) {
    opts.log(
      `[cache] not adopting llama-cpp/${legacyId} for ${opts.modelId}: legacy install is stale (${legacyStale})`,
    );
    return false;
  }

  const source = modelDirInHome(opts.cacheRoot, 'llama-cpp', legacyId);
  const target = modelDirInHome(opts.cacheRoot, 'llama-cpp', opts.modelId);
  await rm(target, { recursive: true, force: true });
  await mkdir(dirname(target), { recursive: true });
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(source, target, type);
  opts.log(`[cache] reused llama-cpp/${legacyId} for renamed catalog id ${opts.modelId}`);
  return true;
}

interface InstallEvent {
  type: 'progress' | 'verifying' | 'extracting-metadata' | 'done' | 'error' | string;
  bytesWritten?: number;
  totalBytes?: number;
  kind?: string;
  id?: string;
  name?: string;
  warning?: string;
  error?: string;
}

/**
 * Ensure the warm cache contains the model. Idempotent: if the manifest +
 * weights are already present, returns immediately. Otherwise spawns a
 * one-shot daemon against the cache root and walks the install SSE stream
 * to completion.
 *
 * `engine` selects which provider's install endpoint to call:
 *   - `llama-cpp` → chat models (Gemma, Qwen, Llama, …)
 *   - `sd-cpp`    → image models (SDXL, SD 1.5, FLUX, …)
 *
 * The daemon spawn here is the one place the harness has to reckon with the
 * first-run bootstrap — we set `firstRunCompleted: true` immediately so the
 * background bootstrap doesn't race us by trying to install a different
 * model on its own.
 */
export async function ensureWarmModel(opts: {
  cacheRoot: string;
  engine: EngineKey;
  modelId: string;
  /** llama-server binary, required for llama-cpp warming. */
  llamaBin?: string;
  /** sd-server binary, required for sd-cpp warming. */
  sdBin?: string;
  /** Abort the warm-up when the owning eval receives SIGINT/SIGTERM. */
  signal?: AbortSignal;
  log: (line: string) => void;
}): Promise<void> {
  opts.signal?.throwIfAborted();
  if (opts.engine === 'llama-cpp' && !opts.llamaBin) {
    throw new Error('ensureWarmModel: llama-cpp engine requires llamaBin');
  }
  if (opts.engine === 'mlx') {
    // MLX warming is not part of this flow — runner symlinks from the
    // user's existing dev cache instead. Refuse to no-op here so a
    // future caller can't accidentally land in a "thinks it warmed,
    // didn't" state.
    throw new Error('ensureWarmModel: MLX warming is handled by the runner, not the cache');
  }
  const { cacheRoot, engine, modelId, log } = opts;
  if (await isModelInstalled(cacheRoot, engine, modelId)) {
    // Present and complete — but the catalog may have moved underneath it.
    // Evict rather than reuse, so the install path below refetches; keeping
    // stale weights would silently invalidate every downstream measurement.
    const stale = await staleInstallReason({ cacheRoot, engine, modelId });
    if (!stale) {
      log(`[cache] ${engine}/${modelId} already warm`);
      return;
    }
    log(`[cache] ${engine}/${modelId} is STALE vs catalog (${stale}) — evicting and refetching`);
    await rm(modelDirInHome(cacheRoot, engine, modelId), { recursive: true, force: true });
  } else if (
    engine === 'llama-cpp' &&
    (await adoptHistoricalLlamaCppAlias({ cacheRoot, modelId, log }))
  ) {
    return;
  }
  await mkdir(cacheRoot, { recursive: true });
  // Heal a stale junction left over from a prior `~/.gezel-dev` link
  // before invoking the install endpoint — see `removeIfDangling`.
  await removeIfDangling(modelDirInHome(cacheRoot, engine, modelId));
  // Wipe any `.partial` files from a prior interrupted/stalled download
  // before re-invoking install. Without this, sd-cpp's SDXL warm path
  // sees the partial, declines to overwrite it, and reports `done` on a
  // never-finished file — leaving the cache permanently broken.
  await purgeStalePartials(modelDirInHome(cacheRoot, engine, modelId), log);

  log(`[cache] warming ${engine}/${modelId} (this can take several minutes on first use)…`);
  const spawned = await spawnTrialDaemon({
    home: cacheRoot,
    ...(opts.llamaBin ? { llamaBin: opts.llamaBin } : {}),
    ...(opts.sdBin ? { sdBin: opts.sdBin } : {}),
    stderrLogPath: join(cacheRoot, `warm-${engine}-stderr.log`),
    timeoutMs: 60_000,
  });

  try {
    // Configure provider so the daemon knows what to use; firstRunCompleted
    // short-circuits the on-device bootstrap that would otherwise install
    // a different chat model in the background.
    if (engine === 'llama-cpp') {
      await spawned.client.updateConfig({
        provider: 'llama-cpp',
        defaultModel: { 'llama-cpp': modelId },
        firstRunCompleted: true,
      });
    } else {
      await spawned.client.updateConfig({
        imageProvider: 'sd-cpp',
        firstRunCompleted: true,
      });
    }

    let lastPct = -1;
    let lastCompanionBucket = -1;
    const handler = (event: InstallEvent) => {
      if (event.type === 'progress') {
        const pct = event.totalBytes
          ? Math.floor(((event.bytesWritten ?? 0) / event.totalBytes) * 100)
          : 0;
        if (pct !== lastPct && pct % 5 === 0) {
          log(
            `[cache] ${engine}/${modelId} download ${pct}% (${event.bytesWritten ?? 0}/${event.totalBytes ?? 0})`,
          );
          lastPct = pct;
        }
      } else if (event.type === 'verifying') {
        log(`[cache] ${engine}/${modelId} verifying`);
      } else if (event.type === 'extracting-metadata') {
        log(`[cache] ${engine}/${modelId} extracting metadata`);
      } else if (event.type === 'companion') {
        // Text-model eval warming explicitly suppresses companions below.
        // Keep this visible if that service contract ever regresses instead
        // of making another multi-GB pull look like a metadata-parser hang.
        const pct = event.totalBytes
          ? Math.floor(((event.bytesWritten ?? 0) / event.totalBytes) * 100)
          : 0;
        const bucket = Math.floor(pct / 5) * 5;
        if (bucket !== lastCompanionBucket || event.error) {
          const label = event.name ?? event.id ?? event.kind ?? 'unknown companion';
          log(
            `[cache] unexpected companion ${label}: ${pct}% (${event.bytesWritten ?? 0}/${event.totalBytes ?? 0}) despite skipCompanion${event.error ? ` — ${event.error}` : ''}`,
          );
          lastCompanionBucket = bucket;
        }
      } else if (event.type === 'done') {
        log(
          `[cache] ${engine}/${modelId} install done${event.warning ? ` (warning: ${event.warning})` : ''}`,
        );
      } else if (event.type === 'error') {
        throw new Error(`model install failed: ${event.error}`);
      }
    };

    if (engine === 'llama-cpp') {
      // Evals warm exactly the model under test. The product install route
      // normally adds a multi-GB image-recognition companion for text-only
      // models and withholds `done` until that second pull finishes. That is
      // useful product behavior, but unrelated and misleading here.
      await spawned.client.installLlamaCppModel(modelId, handler, opts.signal, {
        skipCompanion: true,
      });
    } else {
      await spawned.client.pullImageModel(modelId, handler, opts.signal);
    }

    if (!(await isModelInstalled(cacheRoot, engine, modelId))) {
      throw new Error(
        `install reported done but ${modelDirInHome(cacheRoot, engine, modelId)} has no valid manifest+weights`,
      );
    }
  } finally {
    await shutdownTrialDaemon(spawned);
  }
}

/**
 * Make a warm-cache model visible inside the trial home as a real directory.
 * Product model stores deliberately reject symlinks and junctions, so the
 * eval harness cannot mount a cached model by linking its top-level folder.
 * Clone-copying keeps the trial isolated while remaining cheap on APFS and
 * other copy-on-write filesystems; COPYFILE_FICLONE falls back to an ordinary
 * copy where reflinks are unavailable.
 *
 * Linking the folder instead fails as `refusing a linked or non-directory
 * model-store path`, which the daemon reports as "no model is installed yet"
 * and the trial only surfaces ~300 s later as a `chat-stalled` soft-timeout —
 * five minutes downstream of the real cause, and it hits every model, so a
 * whole sweep measures nothing.
 */
export async function linkModelIntoTrial(opts: {
  cacheRoot: string;
  trialHome: string;
  engine: EngineKey;
  modelId: string;
}): Promise<void> {
  const { cacheRoot, trialHome, engine, modelId } = opts;
  const target = modelDirInHome(cacheRoot, engine, modelId);
  const link = modelDirInHome(trialHome, engine, modelId);
  await mkdir(dirname(link), { recursive: true });
  if (existsSync(link)) return;
  await cloneDirectory(target, link);
}

const execFileAsync = promisify(execFile);

/**
 * Copy-on-write clone one file, or fall back to a byte copy.
 *
 * `copyFile(..., COPYFILE_FICLONE)` does NOT clone on macOS — measured on
 * APFS, a 6.94 GB model file took 3.1 s and consumed 6.6 GB of real space
 * through Node, versus 23 ms and 0 bytes through `cp -c`. The flag is
 * accepted and silently ignored, which is why trial homes for a 16 GB model
 * cost 16 GB apiece: a core-suite run would materialize the same weights
 * eleven times and ENOSPC on a machine with plenty of nominal headroom.
 *
 * The fallback keeps the old behavior wherever cloning is unavailable
 * (non-APFS volumes, Linux CI) — a slower trial setup, never a broken one.
 */
async function cloneFile(source: string, destination: string): Promise<void> {
  if (process.platform === 'darwin') {
    try {
      await execFileAsync('cp', ['-c', source, destination]);
      return;
    } catch {
      // Cross-volume, non-APFS, or a cp that lacks -c: copy the bytes.
    }
  }
  await copyFile(source, destination, constants.COPYFILE_FICLONE);
}

async function cloneDirectory(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) {
      await cloneDirectory(sourcePath, destinationPath);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`refusing to clone linked or non-file model payload: ${sourcePath}`);
    }
    await cloneFile(sourcePath, destinationPath);
  }
}
