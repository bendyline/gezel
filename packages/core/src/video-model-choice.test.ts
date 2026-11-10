import { describe, expect, it } from 'vitest';
import {
  chooseVideoModel,
  videoManifestHasAudio,
  videoModelAnimates,
} from './video-model-choice.js';

const words = { id: 'wan2.1-t2v-1.3b' };
const both = { id: 'wan2.2-ti2v-5b-q4', supportsImageToVideo: true };
const animator = { id: 'wan2.1-i2v-14b', supportsImageToVideo: true, imageToVideoOnly: true };

describe('chooseVideoModel', () => {
  it('makes a clip from words with the default unless it only animates', () => {
    expect(chooseVideoModel([words, both], { defaultModelId: both.id, hasSource: false })).toBe(
      both.id,
    );
    expect(
      chooseVideoModel([animator, words], { defaultModelId: animator.id, hasSource: false }),
    ).toBe(words.id);
    expect(chooseVideoModel([animator], { hasSource: false })).toBeUndefined();
  });

  it("animates a picture with the person's default when it can", () => {
    expect(chooseVideoModel([animator, both], { defaultModelId: both.id, hasSource: true })).toBe(
      both.id,
    );
  });

  it('otherwise prefers a model made for animating, then any that animates', () => {
    expect(
      chooseVideoModel([words, both, animator], { defaultModelId: words.id, hasSource: true }),
    ).toBe(animator.id);
    expect(chooseVideoModel([words, both], { defaultModelId: words.id, hasSource: true })).toBe(
      both.id,
    );
  });

  it('falls back to a model that makes clips from words when nothing animates', () => {
    expect(chooseVideoModel([words], { hasSource: true })).toBe(words.id);
    expect(chooseVideoModel([], { hasSource: true })).toBeUndefined();
  });

  it('reads a model that predates the capability as making clips from words only', () => {
    expect(videoModelAnimates({ id: 'old' })).toBe(false);
    expect(videoModelAnimates(animator)).toBe(true);
  });
});

describe('videoManifestHasAudio', () => {
  it('reads sound from the load flag or an sd.cpp audio decoder', () => {
    expect(videoManifestHasAudio({ load: { audio: true }, source: { files: [] } })).toBe(true);
    expect(
      videoManifestHasAudio({
        source: { files: [{ role: 'diffusion_model' }, { role: 'audio_vae' }] },
      }),
    ).toBe(true);
    expect(videoManifestHasAudio({ source: { files: [{ role: 'vae' }] } })).toBe(false);
  });
});
