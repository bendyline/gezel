import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../fs/store.js';
import { classifyFile } from './classify.js';
import { ContentIndex } from './content-index.js';
import { runWorkspaceContentIndex } from './content-indexer.js';
import type { EnrichDeps } from './enrich.js';
import { parseFrontmatter } from './frontmatter.js';

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
  await runWorkspaceContentIndex(dir, 'c', artifacts);
}

describe('classifyFile audio modality', () => {
  it('classifies audio as its own non-trivial modality', () => {
    expect(classifyFile('standup.m4a', 1000)).toMatchObject({
      kind: 'audio',
      modality: 'audio',
      trivial: false,
    });
    expect(classifyFile('song.mp3', 1000).modality).toBe('audio');
    // Video stays trivial binary — no shadow producer exists for it.
    expect(classifyFile('clip.mp4', 1000).trivial).toBe(true);
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
    await rm(join(dir, '.gezel'), { recursive: true, force: true });
    await runWorkspaceContentIndex(dir, 'c', artifacts);
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
    await runWorkspaceContentIndex(dir, 'c', artifacts);

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
