import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { recordingToDoc } from '../mapper/recordingToDoc.js';
import { poppetjeMediaPath } from '../media.js';
import { loadRecording } from '../recording.js';

const fixtureRaw: unknown = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'transcript.sample.json'), 'utf8'),
);

describe('loadRecording', () => {
  it('accepts the contract fixture', () => {
    const { recording, warnings } = loadRecording(fixtureRaw);
    expect(warnings).toEqual([]);
    expect(recording.scenes).toHaveLength(11);
  });

  it('drops unknown scene kinds with a warning instead of failing playback', () => {
    const raw = structuredClone(fixtureRaw) as { scenes: unknown[] };
    raw.scenes.push({ kind: 'hologram', at: '2026-09-01T10:10:00.000Z' });
    const { recording, warnings } = loadRecording(raw);
    expect(recording.scenes).toHaveLength(11);
    expect(warnings).toHaveLength(1);
  });
});

describe('recordingToDoc', () => {
  const { recording } = loadRecording(fixtureRaw);

  for (const profile of ['debug', 'marketing'] as const) {
    it(`${profile}: produces a monotonic, gap-free, duration-consistent doc`, () => {
      const { doc } = recordingToDoc(recording, profile);
      expect(doc.blocks.length).toBeGreaterThan(2);
      let cursor = 0;
      for (const block of doc.blocks) {
        expect(block.startTime).toBeGreaterThanOrEqual(cursor - 0.01);
        expect(block.duration).toBeGreaterThan(0);
        expect(block.layers?.length ?? 0).toBeGreaterThan(0);
        cursor = block.startTime + block.duration;
      }
      const last = doc.blocks[doc.blocks.length - 1]!;
      expect(doc.duration).toBeCloseTo(last.startTime + last.duration, 1);
      // Synthetic clock: no audio segments, captions present for every block.
      expect(doc.audio.segments).toHaveLength(0);
      expect(doc.captions?.phrases.length).toBe(doc.blocks.length);
    });
  }

  it('marketing: lands near the target duration and within the block budget', () => {
    const { doc } = recordingToDoc(recording, 'marketing');
    expect(doc.blocks.length).toBeLessThanOrEqual(28);
    expect(doc.duration).toBeGreaterThan(60);
    expect(doc.duration).toBeLessThan(160);
    // The money shot always survives selection.
    expect(doc.blocks.some((block) => block.id.endsWith('delegation'))).toBe(true);
  });

  it('debug: shows wall-clock stamps and covers every scene', () => {
    const { doc } = recordingToDoc(recording, 'debug');
    // cover + 11 scenes + outro
    expect(doc.blocks).toHaveLength(13);
    const sceneBlock = doc.blocks[1]!;
    const clock = sceneBlock.layers?.find((layer) => layer.id.endsWith('-clock'));
    expect(clock).toBeDefined();
  });

  it('renders initials avatars without media, poppetje images with it', () => {
    const bare = recordingToDoc(recording, 'debug');
    const bareAvatars = bare.doc.blocks
      .flatMap((block) => block.layers ?? [])
      .filter((layer) => layer.id.includes('avatar'));
    expect(bareAvatars.every((layer) => layer.type !== 'image')).toBe(true);
    expect(bare.media.every((ref) => ref.kind === 'screenshot')).toBe(true);

    const served = recordingToDoc(recording, 'debug', {
      availableMedia: new Set([poppetjeMediaPath('ada'), poppetjeMediaPath('rex')]),
    });
    const imageAvatars = served.doc.blocks
      .flatMap((block) => block.layers ?? [])
      .filter((layer) => layer.id.includes('avatar') && layer.type === 'image');
    expect(imageAvatars.length).toBeGreaterThan(0);
    expect(served.media.some((ref) => ref.kind === 'poppetje')).toBe(true);
  });

  it('screenshot scenes reference the recording-relative file', () => {
    const { doc, media } = recordingToDoc(recording, 'debug');
    const artifactBlock = doc.blocks.find((block) => block.id.endsWith('artifact-produced'));
    const image = artifactBlock?.layers?.find((layer) => layer.type === 'image');
    expect(image && 'content' in image && (image.content as { src: string }).src).toBe(
      'screenshots/00-report.png',
    );
    expect(media).toContainEqual({ path: 'screenshots/00-report.png', kind: 'screenshot' });
  });

  it('is deterministic: identical input, byte-identical doc', () => {
    const a = JSON.stringify(recordingToDoc(recording, 'marketing').doc);
    const b = JSON.stringify(recordingToDoc(recording, 'marketing').doc);
    expect(a).toBe(b);
  });
});
