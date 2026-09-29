import { type RelevanceModelSpec, RelevanceModelSpecSchema } from '@bendyline/gezel';

/**
 * The relevance models gezel can run. Every entry is pinned byte-for-byte
 * (produced by `evals/src/bin/relevance-pin.ts`, reviewed by a person) and
 * starts uncalibrated: `thresholds` come only from the retrieval bench
 * (evals/src/retrieval-bench/LEVERS.md), and an uncalibrated model can
 * reorder results but never drop one. A new pin gets a new id.
 */
export const RELEVANCE_MODELS: readonly RelevanceModelSpec[] = [
  {
    id: 'ms-marco-minilm-l6@1',
    displayName: 'English — faster',
    description:
      'A small English model (about 24 MB) that checks each passage against the request.',
    source: {
      repo: 'Xenova/ms-marco-MiniLM-L-6-v2',
      revision: 'a09144355adeed5f58c8ed011d209bf8ee5a1fec',
      upstream: 'cross-encoder/ms-marco-MiniLM-L6-v2',
    },
    license: {
      spdx: 'Apache-2.0',
      url: 'https://huggingface.co/cross-encoder/ms-marco-MiniLM-L6-v2',
    },
    languages: ['en'],
    architecture: 'bert',
    files: [
      {
        path: 'config.json',
        sha256: 'd827779a72d27ae68cf878a6fc2e954542663fe21ca515d9f4783fc96be2d37e',
        bytes: 824,
      },
      {
        path: 'tokenizer.json',
        sha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
        bytes: 711_396,
      },
      {
        path: 'tokenizer_config.json',
        sha256: '0b29c7bfc889e53b36d9dd3e686dd4300f6525110eaa98c76a5dafceb2029f53',
        bytes: 1_242,
      },
      {
        path: 'onnx/model_quantized.onnx',
        sha256: 'e9d8ebf845c413e981c175bfe49a3bfa9b3dcce2a3ba54875ee5df5a58639fbe',
        bytes: 23_143_499,
      },
    ],
    graph: 'onnx/model_quantized.onnx',
    approxBytes: 23_856_961,
    maxTokens: 512,
    queryMaxTokens: 96,
    scoreActivation: 'sigmoid',
    // Live-confirmed on the retrieval bench (labels 259a61bbaafc9c49). The
    // sigmoid saturates, so the useful cuts sit orders of magnitude below 0.1.
    // Drop is below every live cut that cost search recall: `search` only
    // reorders. See RELEVANCE-CALIBRATION-2026-09-26.md for the arms.
    thresholds: { drop: 0.00001, keep: 0.00003, strong: 0.95 },
    calibration: {
      measuredAt: '2026-09-26',
      evalRun: 'evals/src/retrieval-bench/RELEVANCE-CALIBRATION-2026-09-26.md',
    },
  },
  {
    id: 'mmarco-mminilm-l12@1',
    displayName: 'Many languages',
    description:
      'A multilingual model (about 136 MB) for documents in Dutch, German, French, and other languages.',
    source: {
      repo: 'cross-encoder/mmarco-mMiniLMv2-L12-H384-v1',
      revision: '1427fd652930e4ba29e8149678df786c240d8825',
    },
    license: {
      spdx: 'Apache-2.0',
      url: 'https://huggingface.co/cross-encoder/mmarco-mMiniLMv2-L12-H384-v1',
    },
    languages: ['multilingual'],
    architecture: 'xlm-roberta',
    files: [
      {
        path: 'config.json',
        sha256: 'cc2cfe51aa3fd759d21d21acf5dfd6994aa67a3c9210636d22e143699d336c77',
        bytes: 891,
      },
      {
        path: 'tokenizer.json',
        sha256: '62c24cdc13d4c9952d63718d6c9fa4c287974249e16b7ade6d5a85e7bbb75626',
        bytes: 17_082_660,
      },
      {
        path: 'tokenizer_config.json',
        sha256: 'e7fbfbfa6347b4e414c1cee50d142e2c2f9a895dad68b068ae83a8b564c3837e',
        bytes: 435,
      },
      {
        // Dynamic int8 quantization; the "arm64" in the name is the export
        // target, the operators are portable. Verified on arm64; x64 needs
        // a run before this entry is offered on Windows/Linux x64.
        path: 'onnx/model_qint8_arm64.onnx',
        sha256: '1825907d6c1a9001ff78124780bbde20a614a8c3df3b63409cf3c72c6fe5c8b4',
        bytes: 118_620_017,
      },
    ],
    graph: 'onnx/model_qint8_arm64.onnx',
    approxBytes: 135_704_003,
    maxTokens: 512,
    queryMaxTokens: 96,
    scoreActivation: 'sigmoid',
    thresholds: null,
    calibration: null,
  },
  {
    id: 'mxbai-rerank-xsmall@1',
    displayName: 'English — mixedbread xsmall',
    description: 'An English model (about 96 MB), kept for comparison in the retrieval evals.',
    source: {
      repo: 'mixedbread-ai/mxbai-rerank-xsmall-v1',
      revision: 'b5c6e9da73abc3711f593f705371cdbe9e0fe422',
    },
    license: {
      spdx: 'Apache-2.0',
      url: 'https://huggingface.co/mixedbread-ai/mxbai-rerank-xsmall-v1',
    },
    languages: ['en'],
    architecture: 'deberta-v2',
    files: [
      {
        path: 'config.json',
        sha256: '470a53befc79da411cc04e466770d9f219f3c14adb276bfa0a58df28774ceade',
        bytes: 968,
      },
      {
        path: 'tokenizer.json',
        sha256: '305674b4d785287feecfb5f73f24aa75e9b57c87c579cfe24fbd207987d4b4c4',
        bytes: 8_649_139,
      },
      {
        path: 'tokenizer_config.json',
        sha256: 'aafc9f36a056307bf0cbfcbd42fe00d9df89083d23db6114466c8bfaedb09ce5',
        bytes: 1_447,
      },
      {
        path: 'onnx/model_quantized.onnx',
        sha256: '15ef19a6de90be7d52b627f2c784107bd806e64826450f41fb75fa4f0179ab30',
        bytes: 87_245_802,
      },
    ],
    graph: 'onnx/model_quantized.onnx',
    approxBytes: 95_897_356,
    maxTokens: 512,
    queryMaxTokens: 96,
    scoreActivation: 'sigmoid',
    thresholds: null,
    calibration: null,
    experimental: true,
  },
].map((entry) => RelevanceModelSpecSchema.parse(entry));

export const DEFAULT_RELEVANCE_MODEL_ID = 'ms-marco-minilm-l6@1';

export function findRelevanceModel(id: string): RelevanceModelSpec | null {
  return RELEVANCE_MODELS.find((model) => model.id === id) ?? null;
}
