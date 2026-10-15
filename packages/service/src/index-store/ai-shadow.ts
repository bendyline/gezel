import { readFile } from 'node:fs/promises';
import { createLogger, nowIso } from '@bendyline/gezel';
import { safeJoin } from '@bendyline/gezel-inference/internal/fs/safe-paths';
import { chunkMarkdown, shadowDocFilesPaths, writeConvertedMarkdownAt } from './docs.js';
import { parseFrontmatter, withFrontmatter } from './frontmatter.js';
import type { ChunkInput, FileRecord, IndexProvenance } from './index-store-types.js';
import { type IndexStore, MAX_ENRICH_ATTEMPTS } from './index-store.js';
import { canNormalizeRaster } from './raster-normalize.js';

/**
 * AI-shadow producers: the second shadow-tree producer class. Office docs get
 * deterministic squisq conversions in the STATIC pass; images and audio need
 * a model — a vision description (+OCR) or an STT transcript — so they run in
 * the idle-gated AI tier instead, writing the same
 * `artifacts/shadow/<parent>/<basename>_files/<stem>.md` layout with a YAML
 * frontmatter header carrying source hash + provenance.
 *
 * The sidecar is the artifact; `shadow_state` is only the work gate. The
 * frontmatter's `source_hash` makes the file self-describing: a rebuilt DB
 * (home-fallback flip, deleted index) re-adopts a fresh sidecar without
 * re-paying the model call.
 */

const log = createLogger('enrich');

/**
 * Raster formats the vision stack can actually decode (llama.cpp's mtmd uses
 * stb_image). SVG is a vector format and ICO a multi-frame container — both
 * failed 3-for-3 deterministically in the wild (400 "Failed to load image"),
 * burning engine calls and log noise on every fresh content hash. TIFF is
 * excluded for the same decoder reason (stb_image has no TIFF support) — a
 * deliberate gap, not an oversight: TIFFs stay findable by their filename
 * chunk from the static pass, and routing them through a raster conversion
 * is the follow-up if demand appears.
 */
const VISION_RASTER_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
/** The same set without dots, for `toDecodableRaster`. HEIC and RAW are converted first. */
export const VISION_RASTER_FORMATS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);

function fileExtension(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot).toLowerCase();
}

export interface AiShadowProducers {
  /** Absolute image path → markdown body (description + OCR), null when unavailable. */
  describeImage?: (
    absPath: string,
  ) => Promise<{ body: string; model?: string; provider?: string } | null>;
  /** Absolute audio path → markdown transcript body, null when unavailable. */
  transcribeAudio?: (
    absPath: string,
  ) => Promise<{ body: string; model?: string; provider?: string } | null>;
  /**
   * Whether each producer can run right now (a model chosen and healthy).
   * Checked once per batch: an unavailable producer is left out, so its files
   * wait — no attempt is spent — instead of failing three times and staying
   * undescribed after the person sets a model up.
   */
  describeAvailable?: () => Promise<boolean>;
  transcribeAvailable?: () => Promise<boolean>;
}

export interface AiShadowDeps extends AiShadowProducers {
  provenance?: IndexProvenance;
}

export interface AiShadowResult {
  /** True when a sidecar landed (fresh model output OR a re-adopted sidecar). */
  produced: boolean;
  /** True when the modality's producer is not wired/available. */
  skipped: boolean;
  /** True when a model call was actually paid (vs adoption/skip). */
  called: boolean;
}

/** Ensure the AI shadow for one image/audio file; see module doc. */
export async function aiShadowFile(
  store: IndexStore,
  workspaceDir: string,
  artifactsDir: string,
  file: FileRecord,
  deps: AiShadowDeps,
): Promise<AiShadowResult> {
  const none: AiShadowResult = { produced: false, skipped: true, called: false };
  if (!file.hash) return none;
  const producer = file.modality === 'image' ? deps.describeImage : deps.transcribeAudio;
  if (!producer) return none;
  const paths = shadowDocFilesPaths(artifactsDir, file.path);
  if (!paths) {
    store.markAiShadowAttempt(file.hash, file.path);
    return { produced: false, skipped: false, called: false };
  }

  // Adopt an existing fresh sidecar (rebuilt DB, deleted index) for free.
  const existing = await readFile(paths.mdPath, 'utf8').catch(() => null);
  if (existing !== null) {
    const fm = parseFrontmatter(existing);
    if (fm.data.source_hash === file.hash) {
      indexShadowBody(store, file, fm.body, fm.data.model);
      return { produced: true, skipped: false, called: false };
    }
  }

  // A copy of a file already described elsewhere in the folder reuses that
  // description. Shadow state is kept per content hash but sidecars per path,
  // so describing the copy would pay for the same model call twice — and when
  // that call failed while the twin was being adopted, the shared state
  // flipped between ok and failed on every batch and the tier never stopped
  // (24k "describe produced nothing … attempt 1/3" lines in two minutes).
  const twin = await twinShadow(store, artifactsDir, file);
  if (twin) {
    await writeConvertedMarkdownAt(
      paths,
      withFrontmatter({ ...twin.data, source: file.path }, twin.body),
    );
    indexShadowBody(store, file, twin.body, twin.data.model);
    return { produced: true, skipped: false, called: false };
  }

  // Formats the vision stack cannot decode are a deterministic dead end —
  // mark them terminal without paying (and re-paying) a doomed engine call.
  // Counted as handled (skipped: false) so an all-unsupported batch doesn't
  // read as "no media work left" to the drive loop while real files wait.
  if (
    file.modality === 'image' &&
    !VISION_RASTER_EXTS.has(fileExtension(file.path)) &&
    !canNormalizeRaster(file.path)
  ) {
    store.markAiShadowUnsupported(file.hash, file.path);
    log.info(`no vision support for ${file.path} (no raster decoder for this format) — skipped`);
    return { produced: false, skipped: false, called: false };
  }

  const abs = safeJoin(workspaceDir, file.path);
  if (!abs) {
    store.markAiShadowAttempt(file.hash, file.path);
    return { produced: false, skipped: false, called: false };
  }
  let result: { body: string; model?: string; provider?: string } | null = null;
  try {
    result = await producer(abs);
  } catch {
    result = null;
  }
  if (!result?.body.trim()) {
    const attempts = store.markAiShadowAttempt(file.hash, file.path);
    const verb = file.modality === 'image' ? 'describe' : 'transcribe';
    log.warn(
      attempts >= MAX_ENRICH_ATTEMPTS
        ? `giving up on ${verb} for ${file.path} after ${attempts} attempts — it stays undescribed until its content changes`
        : `${verb} produced nothing for ${file.path} (attempt ${attempts}/${MAX_ENRICH_ATTEMPTS})`,
    );
    return { produced: false, skipped: false, called: true };
  }

  const p = deps.provenance;
  const md = withFrontmatter(
    {
      source: file.path,
      source_hash: file.hash,
      producer: file.modality === 'image' ? 'image-describe' : 'audio-transcribe',
      ...(result.model ? { model: result.model } : {}),
      // The vision/STT ENGINE that produced this body — from the producer
      // itself, never deps.provenance, whose provider names the SUMMARIZER
      // target and would misattribute media work to the wrong stack.
      ...(result.provider ? { provider: result.provider } : {}),
      ...(p?.gezelId ? { gezel_id: p.gezelId } : {}),
      ...(p?.gezelName ? { gezel: p.gezelName } : {}),
      ...(p?.appVersion ? { app_version: p.appVersion } : {}),
      created: nowIso(),
    },
    result.body.trim(),
  );
  await writeConvertedMarkdownAt(paths, md);
  indexShadowBody(store, file, result.body.trim(), result.model);
  return { produced: true, skipped: false, called: true };
}

/** The fresh shadow sidecar of another path with the same content, if one exists. */
async function twinShadow(
  store: IndexStore,
  artifactsDir: string,
  file: FileRecord,
): Promise<{ data: Record<string, string>; body: string } | null> {
  if (!file.hash) return null;
  for (const path of store.pathsWithHash(file.hash)) {
    if (path === file.path) continue;
    const twinPaths = shadowDocFilesPaths(artifactsDir, path);
    const raw = twinPaths ? await readFile(twinPaths.mdPath, 'utf8').catch(() => null) : null;
    if (raw === null) continue;
    const fm = parseFrontmatter(raw);
    if (fm.data.source_hash === file.hash && fm.body.trim()) return fm;
  }
  return null;
}

/**
 * Replace the file's chunks with the shadow body so descriptions/transcripts
 * become searchable, and mark the shadow done in the same write.
 */
function indexShadowBody(
  store: IndexStore,
  file: FileRecord,
  body: string,
  model: string | undefined,
): void {
  if (!file.hash) return;
  store.putAiShadowChunks(file.path, file.hash, shadowBodyChunks(store, file, body), model);
}

/**
 * A shadow body as chunks. The filename-derived line the static pass indexed
 * is folded back in as the first chunk: name search must keep working.
 */
function shadowBodyChunks(store: IndexStore, file: FileRecord, body: string): ChunkInput[] {
  const nameWords = file.path
    .replace(/\.[^.]+$/, '')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .join(' ');
  const meta = store.getMetadata(file.path);
  const dims = meta.width && meta.height ? ` ${meta.width}x${meta.height}` : '';
  const head = `${nameWords}${dims}`.trim();
  const kind = file.modality === 'image' ? 'image' : 'audio';
  return [
    ...(head ? [{ kind, lineStart: 1, lineEnd: 1, text: head }] : []),
    ...chunkMarkdown(body).map((c) => ({ ...c, kind })),
  ];
}

/** Candidates read and written per batch: one page of the scan, one transaction. */
const WIPED_SHADOW_BATCH = 200;

/**
 * Put back AI descriptions and transcripts whose chunks a static pass
 * replaced. Builds that shipped image metadata v3 without
 * `putStaticChunksUnlessDescribed` re-read every photo and indexed its
 * filename line over the description, while the shadow gate stayed 'ok': the
 * AI tier never came back, and the photo was findable by name only, with no
 * vectors. The sidecars under `artifacts/shadow/` survived, so this re-indexes
 * them without a model call. Content with no sidecar on any of its paths goes
 * back to the AI tier to be described again. Idempotent: a restored file no
 * longer matches the scan.
 */
export async function repairWipedAiShadows(
  store: IndexStore,
  artifactsDir: string,
): Promise<{ restored: number; reopened: number }> {
  let restored = 0;
  let reopened = 0;
  let after = '';
  for (;;) {
    const files = store.filesWithWipedAiShadow(after, WIPED_SHADOW_BATCH);
    if (files.length === 0) break;
    after = files[files.length - 1]!.path;
    const repairs: Array<{ filePath: string; contentHash: string; chunks?: ChunkInput[] }> = [];
    for (const file of files) {
      if (!file.hash) continue;
      const body = await recoverShadowBody(store, artifactsDir, file);
      repairs.push({
        filePath: file.path,
        contentHash: file.hash,
        ...(body ? { chunks: shadowBodyChunks(store, file, body) } : {}),
      });
    }
    const counts = store.repairWipedAiShadows(repairs);
    restored += counts.restored;
    reopened += counts.reopened;
  }
  return { restored, reopened };
}

/**
 * The description on disk for this exact content: the file's own sidecar, or
 * a copy's, which is then written as this path's own the way
 * {@link aiShadowFile} adopts a twin. Null when neither exists.
 */
async function recoverShadowBody(
  store: IndexStore,
  artifactsDir: string,
  file: FileRecord,
): Promise<string | null> {
  const paths = shadowDocFilesPaths(artifactsDir, file.path);
  if (!paths) return null;
  const own = await readFile(paths.mdPath, 'utf8').catch(() => null);
  if (own !== null) {
    const fm = parseFrontmatter(own);
    if (fm.data.source_hash === file.hash && fm.body.trim()) return fm.body;
  }
  const twin = await twinShadow(store, artifactsDir, file);
  if (!twin) return null;
  // Best effort: the copy's sidecar still holds the description, so a rebuilt
  // index re-adopts it through the twin even when this write fails.
  await writeConvertedMarkdownAt(
    paths,
    withFrontmatter({ ...twin.data, source: file.path }, twin.body),
  ).catch(() => {});
  return twin.body;
}
