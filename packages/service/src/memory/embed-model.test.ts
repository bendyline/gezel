import { afterEach, describe, expect, it } from 'vitest';
import { embedModelId, queryInstruction } from './embed-core.js';
import { embed, embeddingsDisabledReason } from './embeddings.js';

const prior = process.env.GEZEL_EMBED_MODEL;
const priorNoInstr = process.env.GEZEL_EMBED_NO_QUERY_INSTRUCTION;
const priorDisable = process.env.GEZEL_DISABLE_EMBEDDINGS;
afterEach(() => {
  if (prior === undefined) delete process.env.GEZEL_EMBED_MODEL;
  else process.env.GEZEL_EMBED_MODEL = prior;
  if (priorNoInstr === undefined) delete process.env.GEZEL_EMBED_NO_QUERY_INSTRUCTION;
  else process.env.GEZEL_EMBED_NO_QUERY_INSTRUCTION = priorNoInstr;
  if (priorDisable === undefined) delete process.env.GEZEL_DISABLE_EMBEDDINGS;
  else process.env.GEZEL_DISABLE_EMBEDDINGS = priorDisable;
});

describe('embedModelId', () => {
  it('defaults to bge-small-en-v1.5 and honors the GEZEL_EMBED_MODEL override', () => {
    delete process.env.GEZEL_EMBED_MODEL;
    expect(embedModelId()).toBe('Xenova/bge-small-en-v1.5');
    process.env.GEZEL_EMBED_MODEL = 'Xenova/gte-small';
    expect(embedModelId()).toBe('Xenova/gte-small');
  });
});

describe('queryInstruction', () => {
  it('returns the bge retrieval prefix for bge-* models and empty for symmetric ones', () => {
    delete process.env.GEZEL_EMBED_NO_QUERY_INSTRUCTION;
    process.env.GEZEL_EMBED_MODEL = 'Xenova/bge-small-en-v1.5';
    expect(queryInstruction()).toBe('Represent this sentence for searching relevant passages: ');
    process.env.GEZEL_EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';
    expect(queryInstruction()).toBe('');
    process.env.GEZEL_EMBED_MODEL = 'Xenova/gte-small';
    expect(queryInstruction()).toBe('');
  });

  it('is disabled by GEZEL_EMBED_NO_QUERY_INSTRUCTION for A/B isolation', () => {
    process.env.GEZEL_EMBED_MODEL = 'Xenova/bge-small-en-v1.5';
    process.env.GEZEL_EMBED_NO_QUERY_INSTRUCTION = '1';
    expect(queryInstruction()).toBe('');
  });
});

describe('embedding kill switch', () => {
  it('disables embedding without loading the model', async () => {
    process.env.GEZEL_DISABLE_EMBEDDINGS = '1';
    expect(embeddingsDisabledReason()).toBe('disabled by GEZEL_DISABLE_EMBEDDINGS');
    await expect(embed('offline fixture text')).rejects.toMatchObject({
      code: 'EMBEDDINGS_DISABLED',
    });
  });
});
