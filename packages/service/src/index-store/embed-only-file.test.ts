import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmbeddingsShuttingDownError } from '@bendyline/gezel-inference/internal/memory/embeddings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { embedOnlyFile } from './enrich.js';
import type { FileRecord, IndexStore } from './index-store.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-embed-only-'));
  await writeFile(join(dir, 'a.ts'), 'export const a = 1;\n');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakeStore() {
  return {
    vecAvailable: true,
    getSummary: () => null,
    chunksForFile: () => [{ id: 1, kind: 'section', lineStart: 1, lineEnd: 1, text: 'a = 1' }],
    symbolsForFile: () => [],
    putChunks: vi.fn(),
    addTextVector: vi.fn(),
    markEmbedOnly: vi.fn(),
    markEmbedOnlyAttempt: vi.fn(() => 1),
  };
}

const FILE = { path: 'a.ts', hash: 'h1', kind: 'code', modality: 'code' } as unknown as FileRecord;

describe('embedOnlyFile', () => {
  it('counts a failed embedding against the file and stops the batch', async () => {
    const store = fakeStore();
    const outcome = await embedOnlyFile(
      store as unknown as IndexStore,
      dir,
      dir,
      FILE,
      async () => {
        throw new Error('model failed to load');
      },
    );
    expect(outcome).toBe('unavailable');
    expect(store.markEmbedOnlyAttempt).toHaveBeenCalledWith('h1', 'a.ts');
  });

  it('does not count a shutdown against the file', async () => {
    const store = fakeStore();
    const outcome = await embedOnlyFile(
      store as unknown as IndexStore,
      dir,
      dir,
      FILE,
      async () => {
        throw new EmbeddingsShuttingDownError();
      },
    );
    expect(outcome).toBe('unavailable');
    expect(store.markEmbedOnlyAttempt).not.toHaveBeenCalled();
    expect(store.markEmbedOnly).not.toHaveBeenCalled();
  });
});
