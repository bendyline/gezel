/**
 * `pnpm --filter @bendyline/gezel-evals run media-bench -- --hf-cache <dir> [flags]`
 *
 * Text→media retrieval through the product's media encoders, the same
 * profile, preprocessing and projection the daemon and the catalog compiler
 * use: COCO captions against their photos, ESC-50 class names against their
 * sounds, MSR-VTT captions against their clips. Measures recall and cost per
 * item, then sweeps the per-modality cosine floor against off-topic prompts.
 * Datasets download at run time (datasets.ts); nothing is committed.
 *
 * Flags:
 *   --hf-cache <dir>      transformers cache holding the media-search model at
 *                         its pinned revision (a daemon's <home>/engines/hf-cache
 *                         after Settings → Image recognition installs it, with
 *                         the audio part for --audio/--videos). Default
 *                         GEZEL_HF_CACHE_DIR.
 *   --cache <dir>         dataset cache (default evals/.cache/media-bench)
 *   --images <n>          COCO test images (default 300; 0 skips)
 *   --budgets <list>      vision token budgets to compare (default 280)
 *   --audio-per-class <n> ESC-50 clips per class, 50 classes (default 4; 0 skips)
 *   --videos <n>          MSR-VTT test clips (default 100; 0 skips)
 *   --runs-dir <path>     output folder (default evals/runs/media-bench-<ts>)
 *
 * Method and the recorded run: evals/src/retrieval-bench/MEDIA-BENCH-2026-10-07.md.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  KNOWLEDGE_EMBEDDING_PROFILES,
  createProfileEmbedder,
  profileUnitVector,
} from '@bendyline/gezel-knowledge';
import {
  decodeAudioWindows,
  decodeImage,
  decodeVideoWindows,
  loadMediaEncoder,
  locateFfmpeg,
  readBoundedImageFile,
  rgbaToRgb,
} from '@bendyline/gezel-service/media';
import { repoRoot } from '../native-bin.ts';
import { fetchCocoImages, fetchEsc50, fetchMsrvtt } from '../retrieval-bench/media/datasets.ts';
import { MEDIA_ABSTAIN_QUERIES, esc50Query } from '../retrieval-bench/media/queries.ts';
import {
  type MediaBenchModality,
  type ScoredMediaQuery,
  floorGrid,
  meanReciprocalRank,
  pickMediaFloor,
  recallAtK,
  sweepMediaFloor,
} from '../retrieval-bench/media/sweep.ts';
import { parseArgs } from './args.ts';

const PROFILE_ID = 'embeddinggemma-2-512@1';

interface Corpus {
  label: string;
  modality: MediaBenchModality;
  items: Array<{ id: string; vector: Float32Array }>;
  queries: Array<{ id: string; text: string; relevant: string[] }>;
  secondsPerItem: number;
}

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
  return s;
};

/**
 * Item vectors per corpus, kept in the dataset cache so a rerun (a new floor
 * grid, more abstain prompts) re-scores without re-embedding: video alone is
 * about 15 s a clip.
 */
async function vectorCache(path: string) {
  const stored: Record<string, number[]> = existsSync(path)
    ? JSON.parse(await readFile(path, 'utf8'))
    : {};
  return {
    get: (id: string): Float32Array | undefined => {
      const v = stored[id];
      return v ? Float32Array.from(v) : undefined;
    },
    set: (id: string, v: Float32Array) => {
      stored[id] = Array.from(v);
    },
    save: () => writeFile(path, JSON.stringify(stored)),
  };
}

function meanUnit(vectors: Float32Array[]): Float32Array {
  const out = new Float32Array(vectors[0]?.length ?? 0);
  for (const v of vectors) {
    for (let i = 0; i < v.length; i++) out[i] = (out[i] as number) + (v[i] as number);
  }
  const norm = Math.sqrt(dot(out, out)) || 1;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) / norm;
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const hfCache = String(args.flags['hf-cache'] ?? process.env.GEZEL_HF_CACHE_DIR ?? '');
  if (!hfCache) throw new Error('--hf-cache <dir> (or GEZEL_HF_CACHE_DIR) must hold the model');
  const cacheDir = String(args.flags.cache ?? join(repoRoot(), 'evals', '.cache', 'media-bench'));
  const imageCount = Number(args.flags.images ?? 300);
  const budgets = String(args.flags.budgets ?? '280')
    .split(',')
    .map(Number)
    .filter((n) => n > 0);
  const perClass = Number(args.flags['audio-per-class'] ?? 4);
  const videoCount = Number(args.flags.videos ?? 100);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = args.flags['runs-dir']
    ? String(args.flags['runs-dir'])
    : join(repoRoot(), 'evals', 'runs', `media-bench-${ts}`);
  await mkdir(outDir, { recursive: true });

  const profile = KNOWLEDGE_EMBEDDING_PROFILES.find((p) => p.id === PROFILE_ID);
  if (!profile) throw new Error(`${PROFILE_ID} is not a registered knowledge profile`);
  const load = { cacheDir: hfCache, localFilesOnly: true };
  const unit = (raw: ArrayLike<number>) => profileUnitVector(profile, Float32Array.from(raw));
  const ffmpeg = await locateFfmpeg();
  const corpora: Corpus[] = [];
  const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
    const t = performance.now();
    const value = await fn();
    return [value, (performance.now() - t) / 1000];
  };

  if (imageCount > 0) {
    const images = await fetchCocoImages(cacheDir, imageCount);
    console.log(`coco: ${images.length} images`);
    for (const budget of budgets) {
      const cache = await vectorCache(join(cacheDir, `vectors-${PROFILE_ID}-image@${budget}.json`));
      const encoder = await loadMediaEncoder(profile, {
        ...load,
        modalities: ['image'],
        imageTokenBudget: budget,
      });
      const items: Corpus['items'] = [];
      let seconds = 0;
      let timedItems = 0;
      for (const image of images) {
        let vector: Float32Array | undefined = cache.get(image.id);
        if (!vector) {
          const rgb = rgbaToRgb(decodeImage(await readBoundedImageFile(image.path)));
          const [raw, s] = await timed(() => encoder.embedImage(rgb));
          seconds += s;
          timedItems++;
          vector = unit(raw);
          cache.set(image.id, vector);
        }
        items.push({ id: image.id, vector });
      }
      await encoder.dispose();
      await cache.save();
      corpora.push({
        label: `image@${budget}`,
        modality: 'image',
        items,
        queries: images.map((i) => ({ id: i.id, text: i.captions[0] ?? '', relevant: [i.id] })),
        secondsPerItem: timedItems ? seconds / timedItems : 0,
      });
      console.log(
        `image@${budget}: ${timedItems ? (seconds / timedItems).toFixed(2) : 'cached'} s/image`,
      );
    }
  }

  if ((perClass > 0 || videoCount > 0) && !ffmpeg) {
    console.warn('no ffmpeg found (GEZEL_FFMPEG, SQUISQ_FFMPEG or PATH): skipping audio and video');
  }

  if (perClass > 0 && ffmpeg) {
    const clips = await fetchEsc50(cacheDir, perClass);
    console.log(`esc50: ${clips.length} clips`);
    const cache = await vectorCache(join(cacheDir, `vectors-${PROFILE_ID}-audio.json`));
    const encoder = await loadMediaEncoder(profile, { ...load, modalities: ['audio'] });
    const items: Corpus['items'] = [];
    let seconds = 0;
    let timedItems = 0;
    for (const clip of clips) {
      let vector: Float32Array | undefined = cache.get(clip.id);
      if (!vector) {
        const windows = await decodeAudioWindows(ffmpeg.path, clip.path, profile);
        const vectors: Float32Array[] = [];
        for (const w of windows) {
          const [raw, s] = await timed(() => encoder.embedAudio(w.data));
          seconds += s;
          vectors.push(unit(raw));
        }
        if (vectors.length === 0) continue;
        timedItems++;
        vector = meanUnit(vectors);
        cache.set(clip.id, vector);
      }
      items.push({ id: clip.id, vector });
    }
    await encoder.dispose();
    await cache.save();
    const categories = [...new Set(clips.map((c) => c.category))];
    corpora.push({
      label: 'audio',
      modality: 'audio',
      items,
      queries: categories.map((category) => ({
        id: `esc50:${category}`,
        text: esc50Query(category),
        relevant: clips.filter((c) => c.category === category).map((c) => c.id),
      })),
      secondsPerItem: timedItems ? seconds / timedItems : 0,
    });
    console.log(`audio: ${timedItems ? (seconds / timedItems).toFixed(2) : 'cached'} s/clip`);
  }

  if (videoCount > 0 && ffmpeg) {
    const videos = await fetchMsrvtt(cacheDir, videoCount);
    console.log(`msrvtt: ${videos.length} clips`);
    const cache = await vectorCache(join(cacheDir, `vectors-${PROFILE_ID}-video.json`));
    const encoder = await loadMediaEncoder(profile, { ...load, modalities: ['video'] });
    const items: Corpus['items'] = [];
    let seconds = 0;
    let timedItems = 0;
    for (const video of videos) {
      let vector: Float32Array | undefined = cache.get(video.id);
      if (!vector) {
        const windows = await decodeVideoWindows(ffmpeg.path, video.path, profile);
        const vectors: Float32Array[] = [];
        for (const w of windows) {
          const [raw, s] = await timed(() =>
            encoder.embedVideo(w.data, (w.endMs - w.startMs) / 1000),
          );
          seconds += s;
          vectors.push(unit(raw));
        }
        if (vectors.length === 0) continue;
        timedItems++;
        vector = meanUnit(vectors);
        cache.set(video.id, vector);
      }
      items.push({ id: video.id, vector });
    }
    await encoder.dispose();
    await cache.save();
    corpora.push({
      label: 'video',
      modality: 'video',
      items,
      queries: videos.map((v) => ({ id: v.id, text: v.caption, relevant: [v.id] })),
      secondsPerItem: timedItems ? seconds / timedItems : 0,
    });
    console.log(`video: ${timedItems ? (seconds / timedItems).toFixed(2) : 'cached'} s/clip`);
  }

  const text = await createProfileEmbedder(profile, load);
  // embedQuery already returns the profile's unit vector (truncated, normalized).
  const embedQuery = async (q: string) => Float32Array.from(await text.embedQuery(q));
  const abstainVectors = await Promise.all(MEDIA_ABSTAIN_QUERIES.map(embedQuery));
  const grid = floorGrid(0.4, 0.85, 0.01);
  const results = [];
  const report: string[] = [`# Media bench — ${PROFILE_ID}`, ''];
  for (const corpus of corpora) {
    const scoreAll = (v: Float32Array) =>
      corpus.items.map((item) => ({ id: item.id, cosine: dot(v, item.vector) }));
    const scored: ScoredMediaQuery[] = [];
    for (const q of corpus.queries) {
      scored.push({
        id: q.id,
        modality: corpus.modality,
        abstain: false,
        relevant: q.relevant,
        scores: scoreAll(await embedQuery(q.text)),
      });
    }
    MEDIA_ABSTAIN_QUERIES.forEach((q, i) => {
      scored.push({
        id: `abstain:${i}`,
        modality: corpus.modality,
        abstain: true,
        relevant: [],
        scores: scoreAll(abstainVectors[i] as Float32Array),
      });
    });
    const sweep = sweepMediaFloor(scored, grid);
    const summary = {
      label: corpus.label,
      items: corpus.items.length,
      queries: corpus.queries.length,
      secondsPerItem: corpus.secondsPerItem,
      recallAt1: recallAtK(scored, 1),
      recallAt5: recallAtK(scored, 5),
      recallAt10: recallAtK(scored, 10),
      mrr: meanReciprocalRank(scored),
      floorNoOffTopic: pickMediaFloor(sweep, 0),
      floorOneOffTopic: pickMediaFloor(sweep, 1),
      sweep,
    };
    results.push(summary);
    report.push(
      `## ${corpus.label} — ${summary.items} items, ${summary.queries} queries`,
      '',
      `recall@1 ${summary.recallAt1.toFixed(3)} · @5 ${summary.recallAt5.toFixed(3)} · @10 ${summary.recallAt10.toFixed(3)} · MRR ${summary.mrr.toFixed(3)} · ${summary.secondsPerItem.toFixed(2)} s/item`,
      '',
      `lowest floor with no off-topic prompt reaching an item: ${summary.floorNoOffTopic ?? 'none'}; with at most one: ${summary.floorOneOffTopic ?? 'none'}`,
      '',
      '| floor | answers cleared | off-topic cleared | noise above / query |',
      '|---|---|---|---|',
      ...sweep
        .filter((r) => r.answersCleared > 0 && Math.round(r.floor * 100) % 2 === 0)
        .map(
          (r) =>
            `| ${r.floor.toFixed(2)} | ${r.answersCleared}/${r.answerable} | ${r.offTopicCleared}/${r.abstain} | ${r.meanNoiseAbove.toFixed(1)} |`,
        ),
      '',
    );
  }
  await text.dispose?.();
  await writeFile(join(outDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  await writeFile(join(outDir, 'report.md'), `${report.join('\n')}\n`);
  console.log(report.join('\n'));
  console.log(`wrote ${outDir}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
