import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unloadableRevisions } from './sync-engine-model-support.mjs';

const KOLIBRI = {
  architecture: 'kolibri1',
  key: 'attention.indexer.top_k',
  reads: 'LLM_KV_ATTENTION_INDEXER_TOP_K',
  source: 'src/models/kolibri1.cpp',
  model: 'Kolibri 1.1',
  upstream: 'https://github.com/ggml-org/llama.cpp/pull/32891',
};

test('keeps a revision while the pinned loader never reads its key', () => {
  const sources = {
    'src/models/kolibri1.cpp': 'ml.get_key(LLM_KV_ATTENTION_SLIDING_WINDOW, hparams.n_swa);',
  };
  assert.deepEqual(unloadableRevisions([KOLIBRI], sources), [
    {
      architecture: 'kolibri1',
      key: 'kolibri1.attention.indexer.top_k',
      model: 'Kolibri 1.1',
      upstream: 'https://github.com/ggml-org/llama.cpp/pull/32891',
    },
  ]);
});

test('drops a revision on the bump whose loader reads its key', () => {
  const sources = {
    'src/models/kolibri1.cpp':
      'ml.get_key(LLM_KV_ATTENTION_INDEXER_TOP_K, hparams.indexer_top_k, false);',
  };
  assert.deepEqual(unloadableRevisions([KOLIBRI], sources), []);
});

test('matches the whole constant, not a longer one that starts with it', () => {
  const sources = {
    'src/models/kolibri1.cpp': 'ml.get_key(LLM_KV_ATTENTION_INDEXER_TOP_K_BLOCKS, n);',
  };
  assert.equal(unloadableRevisions([KOLIBRI], sources).length, 1);
});
