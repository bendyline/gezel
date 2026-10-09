import { afterEach, describe, expect, it } from 'vitest';
import {
  EmbeddingsDisabledError,
  EmbeddingsUnavailableError,
  embed,
  openEmbeddings,
  shutdownEmbeddings,
} from './embeddings.js';
import {
  ImageEmbeddingsUnavailableError,
  embedImageFiles,
  openImageEmbeddings,
  shutdownImageEmbeddings,
} from './image-embeddings.js';

const IMAGE = { path: '/nowhere/photo.png', hash: 'abc' } as Parameters<
  typeof embedImageFiles
>[0][number];

afterEach(() => {
  openEmbeddings();
  openImageEmbeddings();
  delete process.env.GEZEL_DISABLE_EMBEDDINGS;
  delete process.env.GEZEL_DISABLE_IMAGE_EMBEDDINGS;
});

describe('model workers at service shutdown', () => {
  it('refuses embedding work once shut down, without loading the model in-process', async () => {
    await shutdownEmbeddings(0);
    await expect(embed('hello')).rejects.toThrow(EmbeddingsUnavailableError);
    await expect(embed('hello')).rejects.toThrow(/shutting down/);
  });

  it('accepts embedding work again when a service reopens it', async () => {
    // An embedded service can stop and start again in the same process. With
    // embeddings switched off by env, the next check proves the latch lifted.
    process.env.GEZEL_DISABLE_EMBEDDINGS = '1';
    await shutdownEmbeddings(0);
    await expect(embed('hello')).rejects.toThrow(/shutting down/);
    openEmbeddings();
    const error = await embed('hello').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(EmbeddingsDisabledError);
    expect(error).not.toBeInstanceOf(EmbeddingsUnavailableError);
  });

  it('refuses image analysis once shut down, and reopens', async () => {
    process.env.GEZEL_DISABLE_IMAGE_EMBEDDINGS = '1';
    await shutdownImageEmbeddings(0);
    await expect(embedImageFiles([IMAGE])).rejects.toThrow(ImageEmbeddingsUnavailableError);
    await expect(embedImageFiles([IMAGE])).rejects.toThrow(/shutting down/);
    openImageEmbeddings();
    await expect(embedImageFiles([IMAGE])).rejects.not.toThrow(/shutting down/);
  });
});
