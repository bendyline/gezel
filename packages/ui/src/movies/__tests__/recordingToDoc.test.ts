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
      // Synthetic clock: no audio segments; captions narrate every SCENE
      // block — cover and outro are full-screen text and carry none.
      expect(doc.audio.segments).toHaveLength(0);
      expect(doc.captions?.phrases.length).toBe(doc.blocks.length - 2);
    });
  }

  it('marketing: lands near the target duration and within the block budget', () => {
    const { doc } = recordingToDoc(recording, 'marketing');
    expect(doc.blocks.length).toBeLessThanOrEqual(28);
    // Target is a ceiling: a short fixture plays at its natural pace (well
    // above the per-scene floor), a long one is compressed to ~2.5 min.
    expect(doc.duration).toBeGreaterThanOrEqual(45);
    expect(doc.duration).toBeLessThanOrEqual(160);
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

  it('credits every speaker with their role and stamps theme fonts on all text', () => {
    const { doc } = recordingToDoc(recording, 'debug');
    const textLayers = doc.blocks.flatMap((block) =>
      (block.layers ?? []).filter((layer) => layer.type === 'text'),
    );
    expect(textLayers.length).toBeGreaterThan(0);
    // No authored text layer may fall back to the platform UI font.
    expect(
      textLayers.every(
        (layer) =>
          typeof (layer as { content: { style: { fontFamily?: string } } }).content.style
            .fontFamily === 'string',
      ),
    ).toBe(true);
    expect(doc.themeId).toBeDefined();
    const nameLabels = textLayers
      .filter((layer) => layer.id.endsWith('-name'))
      .map((layer) => (layer as { content: { text: string } }).content.text);
    expect(nameLabels.some((label) => label.includes('Rex  ·  Reviewer'))).toBe(true);
  });

  it('paces marketing scenes to be readable and leaves harness nudges out of the cut', () => {
    const nudged = structuredClone(recording);
    nudged.scenes.push({
      kind: 'delegation',
      at: '2026-09-01T10:09:50.000Z',
      actorId: 'ada',
      toActorId: 'rex',
      excerpt: '[scenario check] The success criteria are not met yet.',
    });
    const marketing = recordingToDoc(nudged, 'marketing').doc;
    const debug = recordingToDoc(nudged, 'debug').doc;
    const marketingTexts = marketing.blocks.flatMap((block) =>
      (block.layers ?? []).map((layer) =>
        layer.type === 'text' ? (layer as { content: { text: string } }).content.text : '',
      ),
    );
    expect(marketingTexts.some((text) => text.includes('[scenario check]'))).toBe(false);
    const debugTexts = debug.blocks.flatMap((block) =>
      (block.layers ?? []).map((layer) =>
        layer.type === 'text' ? (layer as { content: { text: string } }).content.text : '',
      ),
    );
    expect(debugTexts.some((text) => text.includes('[scenario check]'))).toBe(true);
    // Every scene block (cover/outro excluded) dwells at least the floor.
    for (const block of marketing.blocks.slice(1, -1)) {
      expect(block.duration).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps bubble text inside its bubble, even for the longest excerpts', () => {
    const wordy = structuredClone(recording);
    const long = 'Create the slide design system for the deck and read every source. '.repeat(8);
    wordy.scenes.push(
      { kind: 'reply', at: '2026-09-01T10:09:46.000Z', actorId: 'rex', excerpt: long },
      {
        kind: 'delegation',
        at: '2026-09-01T10:09:47.000Z',
        actorId: 'ada',
        toActorId: 'rex',
        excerpt: long,
      },
    );
    const { doc } = recordingToDoc(wordy, 'debug');
    const pct = (value: string | number | undefined) => Number.parseFloat(String(value ?? '0'));
    let checked = 0;
    for (const block of doc.blocks) {
      const bubble = block.layers?.find((layer) => layer.id.endsWith('-bubble'));
      const body = block.layers?.find((layer) => layer.id.endsWith('-text'));
      if (!bubble || !body) continue;
      checked += 1;
      const bubbleTop = pct(bubble.position.y);
      const bubbleBottom = bubbleTop + pct(bubble.position.height);
      const textTop = pct(body.position.y);
      const textBottom = textTop + pct(body.position.height);
      expect(textTop).toBeGreaterThanOrEqual(bubbleTop);
      expect(textBottom).toBeLessThanOrEqual(bubbleBottom + 0.01);
      expect(bubbleBottom).toBeLessThanOrEqual(100);
    }
    expect(checked).toBeGreaterThan(2);
  });

  it('is deterministic: identical input, byte-identical doc', () => {
    const a = JSON.stringify(recordingToDoc(recording, 'marketing').doc);
    const b = JSON.stringify(recordingToDoc(recording, 'marketing').doc);
    expect(a).toBe(b);
  });
});
