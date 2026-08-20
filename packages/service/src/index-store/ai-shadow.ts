import { readFile } from 'node:fs/promises';
import { createLogger, nowIso } from '@bendyline/gezel';
import { safeJoin } from '../fs/safe-paths.js';
import { chunkMarkdown, shadowDocFilesPaths, writeConvertedMarkdownAt } from './docs.js';
import { parseFrontmatter, withFrontmatter } from './frontmatter.js';
import {
  type FileRecord,
  type IndexProvenance,
  type IndexStore,
  MAX_ENRICH_ATTEMPTS,
} from './index-store.js';

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
      indexShadowBody(store, file, fm.body);
      store.markAiShadowOk(file.hash, file.path, fm.data.model);
      return { produced: true, skipped: false, called: false };
    }
  }

  // Formats the vision stack cannot decode are a deterministic dead end —
  // mark them terminal without paying (and re-paying) a doomed engine call.
  // Counted as handled (skipped: false) so an all-unsupported batch doesn't
  // read as "no media work left" to the drive loop while real files wait.
  if (file.modality === 'image' && !VISION_RASTER_EXTS.has(fileExtension(file.path))) {
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
  indexShadowBody(store, file, result.body.trim());
  store.markAiShadowOk(file.hash, file.path, result.model);
  return { produced: true, skipped: false, called: true };
}

/**
 * Replace the file's chunks with the shadow body so descriptions/transcripts
 * become searchable. The filename-derived line the static pass indexed is
 * folded back in as the first chunk — name search must keep working.
 */
function indexShadowBody(store: IndexStore, file: FileRecord, body: string): void {
  if (!file.hash) return;
  const nameWords = file.path
    .replace(/\.[^.]+$/, '')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .join(' ');
  const meta = store.getMetadata(file.path);
  const dims = meta.width && meta.height ? ` ${meta.width}x${meta.height}` : '';
  const head = `${nameWords}${dims}`.trim();
  const kind = file.modality === 'image' ? 'image' : 'audio';
  store.putChunks(file.path, file.hash, [
    ...(head ? [{ kind, lineStart: 1, lineEnd: 1, text: head }] : []),
    ...chunkMarkdown(body).map((c) => ({ ...c, kind })),
  ]);
}
