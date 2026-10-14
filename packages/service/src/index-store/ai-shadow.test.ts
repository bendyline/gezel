import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { projectContentIndexDbFile } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../fs/store.js';
import { classifyFile } from './classify.js';
import { ContentIndex } from './content-index.js';
import { runWorkspaceContentIndex } from './content-indexer.js';
import type { EnrichDeps } from './enrich.js';
import { parseFrontmatter } from './frontmatter.js';
import { IndexStore } from './index-store.js';
import { TEXT_EMBED_DIM } from './schema.js';

let dir: string;
let home: string;
let artifacts: string;
let ci: ContentIndex;

// Minimal valid PNG header declaring 800x600 (same fixture as content-images).
const PNG_800x600 = Buffer.concat([
  Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x03, 0x20, 0x00, 0x00, 0x02, 0x58, 0x08, 0x02, 0x00, 0x00, 0x00,
  ]),
  Buffer.alloc(8),
]);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-aishadow-'));
  home = await mkdtemp(join(tmpdir(), 'gezel-aishadow-home-'));
  artifacts = join(home, 'artifacts');
  ci = new ContentIndex(
    {
      projectWorkspaceDir: async () => dir,
      projectArtifactsDir: () => artifacts,
    } as unknown as Store,
    home,
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

async function seedMedia(): Promise<void> {
  await mkdir(join(dir, 'photos'), { recursive: true });
  await writeFile(join(dir, 'photos', 'cat-sunset.png'), PNG_800x600);
  await writeFile(join(dir, 'standup.m4a'), 'fake-audio-bytes');
  await runWorkspaceContentIndex(dir, 'c', artifacts, {
    dbPath: projectContentIndexDbFile(home, 'c', dir),
  });
}

describe('classifyFile audio modality', () => {
  it('classifies audio as its own non-trivial modality', () => {
    expect(classifyFile('standup.m4a', 1000)).toMatchObject({
      kind: 'audio',
      modality: 'audio',
      trivial: false,
    });
    expect(classifyFile('song.mp3', 1000).modality).toBe('audio');
    // Video is its own modality — media search embeds its windows — but no
    // shadow producer exists for it, so the AI-shadow pass (image/audio only)
    // never selects it.
    expect(classifyFile('clip.mp4', 1000)).toMatchObject({ modality: 'video', trivial: false });
  });
});

describe('ContentIndex.aiShadows', () => {
  const provenance = { provider: 'mlx', gezelName: 'Noor', appVersion: '1.2.3' };

  it('describes images and transcribes audio into frontmattered shadow sidecars', async () => {
    await seedMedia();
    const describeImage = vi.fn(async (_abs: string) => ({
      body: 'A cat silhouetted against an orange sunset.',
      model: 'vision-x',
    }));
    const transcribeAudio = vi.fn(async (_abs: string) => ({
      body: 'Standup notes: shipped the indexer.',
    }));

    const first = await ci.aiShadows('c', { describeImage, transcribeAudio, provenance }, 10);
    expect(first).toEqual({ files: 2, produced: 2, called: 2 });

    const imageSidecar = join(
      artifacts,
      'shadow',
      'photos',
      'cat-sunset.png_files',
      'cat-sunset.md',
    );
    const audioSidecar = join(artifacts, 'shadow', 'standup.m4a_files', 'standup.md');
    expect(existsSync(imageSidecar)).toBe(true);
    expect(existsSync(audioSidecar)).toBe(true);
    const image = parseFrontmatter(await readFile(imageSidecar, 'utf8'));
    expect(image.data.producer).toBe('image-describe');
    expect(image.data.model).toBe('vision-x');
    expect(image.data.gezel).toBe('Noor');
    expect(image.data.source).toBe('photos/cat-sunset.png');
    expect(image.data.source_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(image.body).toContain('orange sunset');

    // Hash-gated: a second sweep finds nothing to do.
    const second = await ci.aiShadows('c', { describeImage, transcribeAudio, provenance }, 10);
    expect(second).toEqual({ files: 0, produced: 0, called: 0 });
    expect(describeImage).toHaveBeenCalledTimes(1);

    // The shadow body now feeds the summary tier: media joined the
    // enrichment work-list and the summarizer sees the description text.
    const prompts: string[] = [];
    const deps: EnrichDeps = {
      summarize: async (p: string) => {
        prompts.push(p);
        return '';
      },
      embed: async (texts: string[]) => texts.map(() => []),
      model: 'test-model',
    };
    await ci.enrich('c', deps, 10);
    expect(prompts.some((p) => p.includes('orange sunset'))).toBe(true);
    expect(prompts.some((p) => p.includes('shipped the indexer'))).toBe(true);
  });

  it('counts pending media in enrichmentCounts.shadowsPending until described', async () => {
    await seedMedia();
    expect((await ci.enrichmentCounts('c'))?.shadowsPending).toBe(2);

    const describeImage = vi.fn(async (_abs: string) => ({ body: 'described' }));
    const transcribeAudio = vi.fn(async (_abs: string) => ({ body: 'transcribed' }));
    await ci.aiShadows('c', { describeImage, transcribeAudio }, 10);
    expect((await ci.enrichmentCounts('c'))?.shadowsPending).toBe(0);
  });

  it('adopts a fresh sidecar without paying a model call', async () => {
    await seedMedia();
    const describeImage = vi.fn(async (_abs: string) => ({ body: 'fresh description' }));
    const transcribeAudio = vi.fn(async (_abs: string) => ({ body: 'fresh transcript' }));
    await ci.aiShadows('c', { describeImage, transcribeAudio }, 10);

    // Wipe only the DB gate (delete the whole index) — the sidecars remain.
    const dbPath = projectContentIndexDbFile(home, 'c', dir);
    await rm(dirname(dbPath), { recursive: true, force: true });
    await runWorkspaceContentIndex(dir, 'c', artifacts, { dbPath });
    const readopted = await ci.aiShadows('c', { describeImage, transcribeAudio }, 10);
    expect(readopted).toEqual({ files: 2, produced: 2, called: 0 });
    expect(describeImage).toHaveBeenCalledTimes(1);
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
  });

  it('terminally skips vector/icon formats the vision stack cannot decode', async () => {
    await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(join(dir, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(join(dir, 'assets', 'app.ico'), Buffer.from([0, 0, 1, 0, 1, 0]));
    await writeFile(join(dir, 'assets', 'photo.png'), PNG_800x600);
    await runWorkspaceContentIndex(dir, 'c', artifacts, {
      dbPath: projectContentIndexDbFile(home, 'c', dir),
    });

    const describeImage = vi.fn(async (_abs: string) => ({ body: 'described' }));
    const first = await ci.aiShadows('c', { describeImage }, 10);
    // The undecodable formats count as handled (so the drive loop keeps
    // draining) but never reach the model; only the png pays a call.
    expect(describeImage).toHaveBeenCalledTimes(1);
    expect(first?.produced).toBe(1);
    // Terminal: nothing left pending, and a later sweep pays nothing.
    expect((await ci.enrichmentCounts('c'))?.shadowsPending).toBe(0);
    const second = await ci.aiShadows('c', { describeImage }, 10);
    expect(second).toEqual({ files: 0, produced: 0, called: 0 });
    expect(describeImage).toHaveBeenCalledTimes(1);
  });

  it('caps retries for failing producers and skips silently when none are wired', async () => {
    await seedMedia();
    expect(await ci.aiShadows('c', {}, 10)).toEqual({ files: 0, produced: 0, called: 0 });

    const failing = vi.fn(async (_abs: string) => null);
    for (let i = 0; i < 3; i++) {
      const r = await ci.aiShadows('c', { describeImage: failing, transcribeAudio: failing }, 10);
      expect(r?.produced).toBe(0);
    }
    const after = await ci.aiShadows('c', { describeImage: failing, transcribeAudio: failing }, 10);
    expect(after).toEqual({ files: 0, produced: 0, called: 0 });
    expect(failing).toHaveBeenCalledTimes(6);
  });
});

describe('identical copies', () => {
  it('reuses a twin’s description, and goes quiet when the model stops answering', async () => {
    await mkdir(join(dir, 'eval8'), { recursive: true });
    await mkdir(join(dir, 'eval9'), { recursive: true });
    await writeFile(join(dir, 'eval8', 'slide-01.png'), PNG_800x600);
    await writeFile(join(dir, 'eval9', 'attempt9b-slide-01.png'), PNG_800x600);
    await runWorkspaceContentIndex(dir, 'c', artifacts, {
      dbPath: projectContentIndexDbFile(home, 'c', dir),
    });
    // Answers once, then the engine goes away (idle eviction at night).
    const describeImage = vi
      .fn<(abs: string) => Promise<{ body: string; model?: string } | null>>()
      .mockResolvedValueOnce({ body: 'A title slide with a blue band.', model: 'vision-x' })
      .mockResolvedValue(null);

    const runs = [];
    for (let i = 0; i < 4; i++) runs.push(await ci.aiShadows('c', { describeImage }));

    expect(describeImage).toHaveBeenCalledTimes(1);
    expect(runs.at(-1)).toEqual({ files: 0, produced: 0, called: 0 });
    const copy = await readFile(
      join(artifacts, 'shadow', 'eval9', 'attempt9b-slide-01.png_files', 'attempt9b-slide-01.md'),
      'utf8',
    );
    const fm = parseFrontmatter(copy);
    expect(fm.data.source).toBe('eval9/attempt9b-slide-01.png');
    expect(fm.data.model).toBe('vision-x');
    expect(fm.body.trim()).toBe('A title slide with a blue band.');
  });
});

describe('no describer set up', () => {
  it('leaves photos waiting, with their attempts intact, until a model is available', async () => {
    await seedMedia();
    const describeImage = vi.fn(async () => ({ body: 'A cat at sunset.', model: 'vision-x' }));
    let available = false;
    const deps = { describeImage, describeAvailable: async () => available };

    for (let i = 0; i < 5; i++) {
      expect(await ci.aiShadows('c', deps)).toEqual({ files: 0, produced: 0, called: 0 });
    }
    expect(describeImage).not.toHaveBeenCalled();

    available = true;
    expect(await ci.aiShadows('c', deps)).toMatchObject({ produced: 1, called: 1 });
    expect(describeImage).toHaveBeenCalledTimes(1);
  });
});

describe('a forced image metadata re-read', () => {
  const photo = 'photos/cat-sunset.png';
  const dbPath = () => projectContentIndexDbFile(home, 'c', dir);
  const openStore = async () =>
    (await IndexStore.open(dbPath(), { collectionId: 'c', kind: 'workspace', rootPath: dir }))!;
  /** A unit vector per text, so a chunk's own text finds it again. */
  const vectorFor = (text: string): number[] => {
    const v = new Array<number>(TEXT_EMBED_DIM).fill(0);
    for (let i = 0; i < text.length; i++) v[(text.charCodeAt(i) * 31 + i) % TEXT_EMBED_DIM]! += 1;
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  };
  /** As if a newer build bumped the image tier's metadata version. */
  const rollBackImageMetaVersion = async () => {
    const store = await openStore();
    store.setMeta('image_meta_version', '2');
    store.close();
  };

  it('keeps the AI description searchable, by keyword and by vector, without a model call', async () => {
    await seedMedia();
    const describeImage = vi.fn(async (_abs: string) => ({
      body: 'A cat silhouetted against an orange sunset.',
      model: 'vision-x',
    }));
    await ci.aiShadows('c', { describeImage }, 10);
    await ci.enrich(
      'c',
      { summarize: async () => '', embed: async (texts) => texts.map(vectorFor) },
      10,
    );
    let store = await openStore();
    const before = store.chunksForFile(photo);
    const description = before.find((c) => c.text.includes('orange sunset'))!;
    expect(description).toBeDefined();
    store.close();

    await rollBackImageMetaVersion();
    const reread = await runWorkspaceContentIndex(dir, 'c', artifacts, { dbPath: dbPath() });
    expect(reread!.changed).toBe(1);

    store = await openStore();
    try {
      expect(store.getMeta('image_meta_version')).toBe('3');
      expect(store.getMetadata(photo)).toMatchObject({ format: 'png', width: '800' });
      expect(store.chunksForFile(photo)).toEqual(before);
      expect(store.searchDocs('sunset', 5).map((h) => h.filePath)).toContain(photo);
      if (store.vecAvailable) {
        const [hit] = store.searchTextVectors(vectorFor(description.text), 1);
        expect(hit?.chunkId).toBe(description.id);
      }
      // Nothing is left for a tier to redo: no shadow, no summary pass, no embedding.
      expect(store.filesNeedingAiShadow(10).map((f) => f.path)).not.toContain(photo);
      expect(store.countNeedingEnrichment()).toBe(0);
      expect(store.countNeedingEmbedOnly()).toBe(0);
    } finally {
      store.close();
    }
    expect(await ci.aiShadows('c', { describeImage }, 10)).toEqual({
      files: 0,
      produced: 0,
      called: 0,
    });
    expect(describeImage).toHaveBeenCalledTimes(1);
  });

  it('still refreshes the name chunk of a photo no model has described', async () => {
    await seedMedia();
    let store = await openStore();
    const hash = store.getFile(photo)!.hash!;
    store.putChunks(photo, hash, [{ kind: 'image', lineStart: 1, lineEnd: 1, text: 'stale' }]);
    store.close();

    await rollBackImageMetaVersion();
    await runWorkspaceContentIndex(dir, 'c', artifacts, { dbPath: dbPath() });

    store = await openStore();
    try {
      expect(store.chunksForFile(photo).map((c) => c.text)).toEqual([
        'photos cat sunset png 800x600',
      ]);
    } finally {
      store.close();
    }
  });
});

describe('indexing an AI shadow', () => {
  it('writes the description chunks and the shadow gate together or not at all', async () => {
    await seedMedia();
    const store = (await IndexStore.open(projectContentIndexDbFile(home, 'c', dir), {
      collectionId: 'c',
      kind: 'workspace',
      rootPath: dir,
    }))!;
    try {
      const photo = 'photos/cat-sunset.png';
      const hash = store.getFile(photo)!.hash!;
      const before = store.chunksForFile(photo);
      const chunks = [{ kind: 'image', lineStart: 1, lineEnd: 1, text: 'a described cat' }];
      const markOk = vi.spyOn(store, 'markAiShadowOk').mockImplementationOnce(() => {
        throw new Error('simulated failure after the chunk write');
      });

      expect(() => store.putAiShadowChunks(photo, hash, chunks, 'vision-x')).toThrow(/simulated/);
      expect(store.chunksForFile(photo)).toEqual(before);
      expect(store.filesNeedingAiShadow(10).map((f) => f.path)).toContain(photo);

      markOk.mockRestore();
      store.putAiShadowChunks(photo, hash, chunks, 'vision-x');
      expect(store.chunksForFile(photo).map((c) => c.text)).toEqual(['a described cat']);
      expect(store.filesNeedingAiShadow(10).map((f) => f.path)).not.toContain(photo);
    } finally {
      store.close();
    }
  });
});
