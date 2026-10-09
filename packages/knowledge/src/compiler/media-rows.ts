/**
 * Media rows (format 0.8): the images, video windows and audio windows a
 * catalog's documents reference, embedded into the catalog's own vector
 * space and stored as rows of the shard `chunks` table beside the text.
 *
 * The compiler never decodes media. A producer injects `embedMedia` — the
 * CLI wires the service's media encoder, tests a deterministic fake — which
 * receives one asset and returns one result for an image or one per time
 * window for audio and video. Everything else is decided here: which
 * references count, what text a row carries for full-text search and the
 * relevance judge, its heading context, and its content hash.
 */

import { createHash } from 'node:crypto';
import {
  type KnowledgeAssetModality,
  type KnowledgeEmbeddingProfile,
  assetContentType,
  assetModality,
} from '@bendyline/gezk';
import type { MarkdownChunk } from '../chunking/markdown-chunker.js';

/** One asset handed to the producer's media embedder. */
export interface MediaEmbedRequest {
  modality: KnowledgeAssetModality;
  /** Archive path, `assets/…`. */
  path: string;
  bytes: Buffer;
}

/**
 * One embedded piece of an asset: the whole image, or one window of audio or
 * video. `vector` is the model's raw output; the compiler projects it
 * through the profile like a text passage.
 */
export interface MediaEmbedResult {
  vector: number[];
  startMs?: number;
  endMs?: number;
  width?: number;
  height?: number;
  /** Speech heard in this window, when the producer transcribed it. */
  transcript?: string;
}

export type MediaEmbedder = (request: MediaEmbedRequest) => Promise<MediaEmbedResult[]>;

/** One media row as the writer stores it. */
export interface MediaRow {
  modality: KnowledgeAssetModality;
  assetPath: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  startMs: number | null;
  endMs: number | null;
  attributionJson: string | null;
  headingPath: string[];
  line: number;
  text: string;
  contentHash: string;
  vector: number[];
}

/** The longest row text kept, in profile tokens: a caption, not an article. */
export const MEDIA_ROW_TEXT_MAX_TOKENS = 128;
/** Media rows one document may carry. */
export const MAX_MEDIA_ROWS_PER_DOCUMENT = 1_024;

const MEDIA_REFERENCE = /!\[([^\]\n]*)\]\(\s*<?(assets\/[^)\s>]+)>?(?:\s+"[^"\n]*")?\s*\)/g;

/** Every `![alt](assets/…)` in a body, with its 1-based line and that line's other text. */
export function mediaReferences(
  markdown: string,
): Array<{ alt: string; path: string; line: number; caption: string }> {
  const out: Array<{ alt: string; path: string; line: number; caption: string }> = [];
  markdown.split('\n').forEach((text, index) => {
    for (const match of text.matchAll(MEDIA_REFERENCE)) {
      out.push({
        alt: (match[1] ?? '').trim(),
        path: match[2] as string,
        line: index + 1,
        caption: text.replace(MEDIA_REFERENCE, ' ').replace(/\s+/g, ' ').trim(),
      });
    }
  });
  return out;
}

/** `assets/diagrams/red-panda_habitat.png` → `red panda habitat`. */
export function humanizeAssetName(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const stem = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
  return stem
    .replace(/[-_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function boundedText(parts: string[], countTokens: (text: string) => number): string {
  const unique: string[] = [];
  for (const part of parts.map((p) => p.trim()).filter(Boolean)) {
    if (!unique.some((u) => u.toLowerCase() === part.toLowerCase())) unique.push(part);
  }
  let text = unique.join('\n').normalize('NFC');
  if (countTokens(text) <= MEDIA_ROW_TEXT_MAX_TOKENS) return text;
  const words = text.split(/(\s+)/);
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (countTokens(words.slice(0, mid).join('')) <= MEDIA_ROW_TEXT_MAX_TOKENS) lo = mid;
    else hi = mid - 1;
  }
  text = words.slice(0, lo).join('').trim();
  return text;
}

function headingAt(chunks: MarkdownChunk[], line: number): string[] {
  const inside = chunks.find((c) => c.lineStart <= line && line <= c.lineEnd);
  if (inside) return inside.headingPath;
  let before: MarkdownChunk | undefined;
  for (const c of chunks) if (c.lineEnd < line) before = c;
  return before?.headingPath ?? [];
}

/** A window's identity: the asset's bytes plus the span it covers. */
function windowHash(assetSha256: string, startMs: number | null, endMs: number | null): string {
  if (startMs === null || endMs === null) return assetSha256;
  return createHash('sha256').update(`${assetSha256}\u0000${startMs}\u0000${endMs}`).digest('hex');
}

/**
 * Embed every media asset the documents reference (each asset once, however
 * many documents use it) and lay out each document's media rows, ordered by
 * reference line, then start time. A modality the profile does not describe,
 * or one the embedder declines (returns no results for), yields no rows.
 */
export async function collectMediaRows(args: {
  documents: Array<{ id: string; title: string; markdown: string; chunks: MarkdownChunk[] }>;
  assets: ReadonlyArray<{
    path: string;
    bytes: Buffer;
    sha256: string;
    attribution?: Record<string, unknown>;
  }>;
  profile: KnowledgeEmbeddingProfile;
  embedMedia: MediaEmbedder;
  countTokens: (text: string) => number;
  onWarning?: (message: string) => void;
}): Promise<Map<string, MediaRow[]>> {
  const byPath = new Map(args.assets.map((a) => [a.path, a]));
  const embedded = new Map<string, Promise<MediaEmbedResult[]>>();
  const warned = new Set<string>();
  const out = new Map<string, MediaRow[]>();
  for (const doc of args.documents) {
    const rows: MediaRow[] = [];
    const seen = new Set<string>();
    for (const ref of mediaReferences(doc.markdown)) {
      if (seen.has(ref.path)) continue;
      seen.add(ref.path);
      const asset = byPath.get(ref.path);
      const modality = assetModality(ref.path);
      const mimeType = assetContentType(ref.path);
      if (!asset || !modality || !mimeType || mimeType === 'image/svg+xml') continue;
      const block =
        modality === 'audio'
          ? args.profile.media?.audio
          : modality === 'video'
            ? args.profile.media?.video
            : args.profile.media?.image;
      if (!block) {
        if (!warned.has(modality)) {
          warned.add(modality);
          args.onWarning?.(
            `profile ${args.profile.id} describes no ${modality} encoder; ${modality} references get no media rows`,
          );
        }
        continue;
      }
      let pending = embedded.get(ref.path);
      if (!pending) {
        pending = args.embedMedia({ modality, path: ref.path, bytes: asset.bytes });
        embedded.set(ref.path, pending);
      }
      const results = [...(await pending)].sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
      const headingPath = headingAt(doc.chunks, ref.line);
      for (const result of results) {
        const startMs = modality === 'image' ? null : (result.startMs ?? 0);
        const endMs = modality === 'image' ? null : (result.endMs ?? null);
        if (startMs !== null && (endMs === null || endMs <= startMs)) {
          throw new Error(`${ref.path}: a ${modality} window needs startMs < endMs`);
        }
        rows.push({
          modality,
          assetPath: ref.path,
          mimeType,
          width: result.width ?? null,
          height: result.height ?? null,
          startMs,
          endMs,
          attributionJson: asset.attribution ? JSON.stringify(asset.attribution) : null,
          headingPath,
          line: ref.line,
          text: boundedText(
            [ref.alt, ref.caption, humanizeAssetName(ref.path), result.transcript ?? ''],
            args.countTokens,
          ),
          contentHash: windowHash(asset.sha256, startMs, endMs),
          vector: result.vector,
        });
      }
    }
    if (rows.length > MAX_MEDIA_ROWS_PER_DOCUMENT) {
      throw new Error(
        `document ${doc.id} has ${rows.length} media rows; the limit is ${MAX_MEDIA_ROWS_PER_DOCUMENT}`,
      );
    }
    if (rows.length > 0) out.set(doc.id, rows);
  }
  return out;
}
