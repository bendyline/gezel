import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PipelineLoadError } from '../memory/embed-core.js';
import {
  type RelevanceTransformers,
  type ResolvedRelevanceModel,
  activate,
  disposeRelevanceModels,
  scoreRelevancePairs,
} from './relevance-core.js';

const words = (text: string) => text.toLowerCase().match(/[a-z]+/g) ?? [];

/**
 * A fake cross-encoder: one logit = word overlap between query and passage.
 * Enough to pass the load-time self-check, and to count batches.
 */
function fakeTransformers(opts: { constant?: boolean; noSegments?: boolean } = {}) {
  const calls: number[] = [];
  const vocab = new Map<string, number>();
  const id = (word: string) => {
    if (!vocab.has(word)) vocab.set(word, vocab.size + 10);
    return vocab.get(word)!;
  };
  const reverse = (tokenId: number) => [...vocab.entries()].find(([, v]) => v === tokenId)?.[0];
  const tokenizer = Object.assign(
    (queries: string[], o: { text_pair: string[] }) => {
      calls.push(queries.length);
      const overlaps = queries.map((q, i) => {
        const qs = new Set(words(q));
        return words(o.text_pair[i] ?? '').filter((w) => qs.has(w)).length;
      });
      return {
        input_ids: { data: overlaps, dims: [queries.length, 1] },
        token_type_ids: {
          data: queries.map(() => (opts.noSegments ? 0 : 1)),
          dims: [queries.length, 1],
        },
      };
    },
    {
      encode: (text: string, o?: { text_pair?: string; add_special_tokens?: boolean }) =>
        o?.text_pair !== undefined ? [1, 2, 2] : words(text).map(id),
      decode: (ids: number[]) => ids.map(reverse).join(' '),
    },
  );
  const model = Object.assign(
    async (inputs: Record<string, { data: number[]; dims: number[] }>) => ({
      logits: {
        data: inputs.input_ids!.data.map((overlap) => (opts.constant ? 0 : overlap * 2 - 1)),
        dims: [inputs.input_ids!.dims[0]!, 1],
      },
    }),
    { sessions: { model: { inputNames: ['input_ids', 'attention_mask', 'token_type_ids'] } } },
  );
  const transformers = {
    AutoTokenizer: { from_pretrained: async () => tokenizer },
    AutoModelForSequenceClassification: { from_pretrained: async () => model },
  } as unknown as RelevanceTransformers;
  return { transformers, calls };
}

describe('relevance core', () => {
  let dir: string;
  let model: ResolvedRelevanceModel;

  beforeEach(async () => {
    disposeRelevanceModels();
    dir = await mkdtemp(join(tmpdir(), 'relevance-core-'));
    await mkdir(join(dir, 'onnx'));
    const graph = Buffer.from('fake onnx graph');
    await writeFile(join(dir, 'onnx', 'model_quantized.onnx'), graph);
    model = {
      id: 'fake@1',
      dir,
      graph: 'onnx/model_quantized.onnx',
      graphSha256: createHash('sha256').update(graph).digest('hex'),
      maxTokens: 64,
      queryMaxTokens: 16,
      scoreActivation: 'sigmoid',
    };
  });

  afterEach(async () => {
    disposeRelevanceModels();
    await rm(dir, { recursive: true, force: true });
  });

  it('scores each passage against the query, in batches of at most eight', async () => {
    const { transformers, calls } = fakeTransformers();
    const passages = Array.from({ length: 19 }, (_, i) =>
      i === 7 ? 'quiche is a savoury tart' : 'unrelated filler text',
    );
    const out = await scoreRelevancePairs(
      model,
      'savoury quiche tart',
      passages,
      undefined,
      transformers,
    );
    expect(out.partial).toBe(false);
    expect(out.scores[7]!).toBeGreaterThan(out.scores[0]!);
    // Self-check (2 passages, then a 1-pair segment probe), then 8 + 8 + 3.
    expect(calls).toEqual([2, 1, 8, 8, 3]);
  });

  it('stops at the deadline and leaves the rest unscored', async () => {
    const { transformers } = fakeTransformers();
    const out = await scoreRelevancePairs(model, 'q', ['a', 'b'], Date.now() - 1, transformers);
    expect(out.partial).toBe(true);
    expect(out.scores).toEqual([null, null]);
  });

  it('refuses a model that cannot tell an answer from a non-answer', async () => {
    const { transformers } = fakeTransformers({ constant: true });
    await expect(scoreRelevancePairs(model, 'q', ['a'], undefined, transformers)).rejects.toThrow(
      /self-check/,
    );
  });

  it('refuses a pair encoding that never marks the passage segment', async () => {
    const { transformers } = fakeTransformers({ noSegments: true });
    await expect(scoreRelevancePairs(model, 'q', ['a'], undefined, transformers)).rejects.toThrow(
      /passage segment/,
    );
  });

  it('refuses a graph that does not match its pin', async () => {
    const { transformers } = fakeTransformers();
    const tampered = { ...model, graphSha256: 'f'.repeat(64) };
    await expect(
      scoreRelevancePairs(tampered, 'q', ['a'], undefined, transformers),
    ).rejects.toBeInstanceOf(PipelineLoadError);
  });

  it('activates one logit with a sigmoid and two with a softmax', () => {
    expect(activate([0], 'sigmoid')).toBeCloseTo(0.5);
    expect(activate([0, Math.log(3)], 'softmax-positive')).toBeCloseTo(0.75);
  });
});
