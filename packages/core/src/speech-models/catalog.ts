export interface SpeechModelFile {
  /** Path inside the model folder, `/`-separated. */
  readonly name: string;
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
}

export interface SpeechModelEntry {
  readonly id: string;
  readonly kind: 'stt' | 'tts';
  readonly label: string;
  readonly description: string;
  readonly recommended: boolean;
  readonly license: string;
  readonly licenseUrl: string;
  readonly files: readonly SpeechModelFile[];
  /**
   * Where Gezel keeps the same file, relative to the user's home, when it
   * downloads this model itself. A verified copy there is used read-only.
   */
  readonly sharedPath?: readonly string[];
}

const WHISPER_COMMIT = '5359861c739e955e79d9a303bcbc70fb988958b1';
export const KOKORO_MODEL_COMMIT = 'dd4401a9add81ac692d20e240d22ec9dda82cc29';
export const KOKORO_VOICES_COMMIT = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';
const whisperUrl = (file: string) =>
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_COMMIT}/${file}`;
const kokoroVoiceUrl = (file: string) =>
  `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/${KOKORO_VOICES_COMMIT}/${file}`;

function whisper(
  id: string,
  label: string,
  description: string,
  file: string,
  sha256: string,
  size: number,
  recommended = false,
): SpeechModelEntry {
  return {
    id,
    kind: 'stt',
    label,
    description,
    recommended,
    license: 'MIT',
    licenseUrl: 'https://github.com/openai/whisper/blob/main/LICENSE',
    files: [{ name: file, url: whisperUrl(file), sha256, size }],
    sharedPath: ['.gezel', 'engines', 'whisper-cpp', 'models', id, file],
  };
}

export const KOKORO_MODEL_ID = 'kokoro-82m-v1.0';
export const KOKORO_DEFAULT_VOICE = 'af_heart';
export const KOKORO_SAMPLE_RATE = 24_000;

/** Gezel's curated voices (`KOKORO_DEFAULT_VOICES`), in its order. */
export const KOKORO_VOICES: readonly {
  readonly id: string;
  readonly label: string;
  readonly language: string;
  readonly gender: 'female' | 'male';
  readonly modelId: string;
  readonly sha256: string;
}[] = [
  [
    'af_heart',
    'Heart',
    'en-US',
    'female',
    'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b',
  ],
  [
    'af_bella',
    'Bella',
    'en-US',
    'female',
    'f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b',
  ],
  [
    'af_nicole',
    'Nicole',
    'en-US',
    'female',
    'cd2191ab31b914ed7b318416b0e4440fdf392ddad9106a060819aa600a64f59a',
  ],
  [
    'am_adam',
    'Adam',
    'en-US',
    'male',
    '162b035ed91cfc48b6046982184c645f72edcdd1b82843347f605d7bf7b15716',
  ],
  [
    'am_michael',
    'Michael',
    'en-US',
    'male',
    '1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1',
  ],
  [
    'bf_emma',
    'Emma',
    'en-GB',
    'female',
    '669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73',
  ],
  [
    'bm_george',
    'George',
    'en-GB',
    'male',
    'c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc',
  ],
  [
    'bm_lewis',
    'Lewis',
    'en-GB',
    'male',
    'b8f671cef828c30e66fdf0b0756a76bba58f6bb3398cbbf27058642acbcedb97',
  ],
].map(([id, label, language, gender, sha256]) => ({
  id: id as string,
  label: label as string,
  language: language as string,
  gender: gender as 'female' | 'male',
  modelId: KOKORO_MODEL_ID,
  sha256: sha256 as string,
}));

/** 510 style vectors × 256 float32 values per voice. */
export const KOKORO_VOICE_BYTES = 522_240;
export const KOKORO_MODEL_FILE = 'onnx/model_quantized.onnx';

export const SPEECH_MODEL_CATALOG: readonly SpeechModelEntry[] = [
  whisper(
    'whisper-tiny.en',
    'Whisper Tiny (English)',
    'Fastest. Good for short notes on slower machines.',
    'ggml-tiny.en.bin',
    '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f',
    77_704_715,
  ),
  whisper(
    'whisper-base.en',
    'Whisper Base (English)',
    'Recommended. Realtime on most laptops.',
    'ggml-base.en.bin',
    'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002',
    147_964_211,
    true,
  ),
  whisper(
    'whisper-small.en',
    'Whisper Small (English)',
    'Most accurate. Slower; better on hard audio.',
    'ggml-small.en.bin',
    'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d',
    487_614_201,
  ),
  {
    id: KOKORO_MODEL_ID,
    kind: 'tts',
    label: 'Kokoro (English voices)',
    description: 'Natural US and UK English narration voices.',
    recommended: true,
    license: 'Apache-2.0',
    licenseUrl: 'https://huggingface.co/hexgrad/Kokoro-82M/blob/main/LICENSE',
    files: [
      {
        name: KOKORO_MODEL_FILE,
        // `durations` contains float predictions BEFORE ONNX Round (ties to
        // even) and Clip(min=1). Each resulting frame is 600 samples at 24 kHz.
        url: `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped/resolve/${KOKORO_MODEL_COMMIT}/${KOKORO_MODEL_FILE}`,
        sha256: 'c0c02b3299fd97c34ea92a98e6d41eaa1a739c8f77bf685aac34bd7b34c1132c',
        size: 92_361_055,
      },
      ...KOKORO_VOICES.map((voice) => ({
        name: `voices/${voice.id}.bin`,
        url: kokoroVoiceUrl(`voices/${voice.id}.bin`),
        sha256: voice.sha256,
        size: KOKORO_VOICE_BYTES,
      })),
    ],
  },
];

export function catalogEntry(id: string): SpeechModelEntry | undefined {
  return SPEECH_MODEL_CATALOG.find((entry) => entry.id === id);
}

export function downloadBytes(entry: SpeechModelEntry): number {
  return entry.files.reduce((sum, file) => sum + file.size, 0);
}

export const KOKORO_HF_REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX-timestamped';

/** Metadata needed by the Gezel Transformers.js loader; DocBlocks loads ONNX directly. */
export const KOKORO_TRANSFORMERS_FILES: readonly SpeechModelFile[] = [
  {
    name: 'config.json',
    url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped/resolve/dd4401a9add81ac692d20e240d22ec9dda82cc29/config.json',
    size: 44,
    sha256: 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f',
  },
  {
    name: 'tokenizer.json',
    url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped/resolve/dd4401a9add81ac692d20e240d22ec9dda82cc29/tokenizer.json',
    size: 3497,
    sha256: '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34',
  },
  {
    name: 'tokenizer_config.json',
    url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped/resolve/dd4401a9add81ac692d20e240d22ec9dda82cc29/tokenizer_config.json',
    size: 113,
    sha256: 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20',
  },
];

/** Apache-2.0 model metadata from the pinned timestamped export, shipped to keep loads offline. */
export const KOKORO_TRANSFORMERS_METADATA: Readonly<Record<string, string>> = {
  'config.json': '{\n  "model_type": "style_text_to_speech_2"\n}',
  'tokenizer.json':
    '{\n  "version": "1.0",\n  "truncation": null,\n  "padding": null,\n  "added_tokens": [],\n  "normalizer": {\n    "type": "Replace",\n    "pattern": {\n      "Regex": "[^$;:,.!?\\u2014\\u2026\\"()\\u201c\\u201d \\u0303\\u02a3\\u02a5\\u02a6\\u02a8\\u1d5d\\uab67AIOQSTWY\\u1d4aabcdefhijklmnopqrstuvwxyz\\u0251\\u0250\\u0252\\u00e6\\u03b2\\u0254\\u0255\\u00e7\\u0256\\u00f0\\u02a4\\u0259\\u025a\\u025b\\u025c\\u025f\\u0261\\u0265\\u0268\\u026a\\u029d\\u026f\\u0270\\u014b\\u0273\\u0272\\u0274\\u00f8\\u0278\\u03b8\\u0153\\u0279\\u027e\\u027b\\u0281\\u027d\\u0282\\u0283\\u0288\\u02a7\\u028a\\u028b\\u028c\\u0263\\u0264\\u03c7\\u028e\\u0292\\u0294\\u02c8\\u02cc\\u02d0\\u02b0\\u02b2\\u2193\\u2192\\u2197\\u2198\\u1d7b]"\n    },\n    "content": ""\n  },\n  "pre_tokenizer": {\n    "type": "Split",\n    "pattern": {\n      "Regex": ""\n    },\n    "behavior": "Isolated",\n    "invert": false\n  },\n  "post_processor": {\n    "type": "TemplateProcessing",\n    "single": [\n      {\n        "SpecialToken": {\n          "id": "$",\n          "type_id": 0\n        }\n      },\n      {\n        "Sequence": {\n          "id": "A",\n          "type_id": 0\n        }\n      },\n      {\n        "SpecialToken": {\n          "id": "$",\n          "type_id": 0\n        }\n      }\n    ],\n    "special_tokens": {\n      "$": {\n        "id": "$",\n        "ids": [\n          0\n        ],\n        "tokens": [\n          "$"\n        ]\n      }\n    }\n  },\n  "decoder": null,\n  "model": {\n    "vocab": {\n      "$": 0,\n      ";": 1,\n      ":": 2,\n      ",": 3,\n      ".": 4,\n      "!": 5,\n      "?": 6,\n      "\\u2014": 9,\n      "\\u2026": 10,\n      "\\"": 11,\n      "(": 12,\n      ")": 13,\n      "\\u201c": 14,\n      "\\u201d": 15,\n      " ": 16,\n      "\\u0303": 17,\n      "\\u02a3": 18,\n      "\\u02a5": 19,\n      "\\u02a6": 20,\n      "\\u02a8": 21,\n      "\\u1d5d": 22,\n      "\\uab67": 23,\n      "A": 24,\n      "I": 25,\n      "O": 31,\n      "Q": 33,\n      "S": 35,\n      "T": 36,\n      "W": 39,\n      "Y": 41,\n      "\\u1d4a": 42,\n      "a": 43,\n      "b": 44,\n      "c": 45,\n      "d": 46,\n      "e": 47,\n      "f": 48,\n      "h": 50,\n      "i": 51,\n      "j": 52,\n      "k": 53,\n      "l": 54,\n      "m": 55,\n      "n": 56,\n      "o": 57,\n      "p": 58,\n      "q": 59,\n      "r": 60,\n      "s": 61,\n      "t": 62,\n      "u": 63,\n      "v": 64,\n      "w": 65,\n      "x": 66,\n      "y": 67,\n      "z": 68,\n      "\\u0251": 69,\n      "\\u0250": 70,\n      "\\u0252": 71,\n      "\\u00e6": 72,\n      "\\u03b2": 75,\n      "\\u0254": 76,\n      "\\u0255": 77,\n      "\\u00e7": 78,\n      "\\u0256": 80,\n      "\\u00f0": 81,\n      "\\u02a4": 82,\n      "\\u0259": 83,\n      "\\u025a": 85,\n      "\\u025b": 86,\n      "\\u025c": 87,\n      "\\u025f": 90,\n      "\\u0261": 92,\n      "\\u0265": 99,\n      "\\u0268": 101,\n      "\\u026a": 102,\n      "\\u029d": 103,\n      "\\u026f": 110,\n      "\\u0270": 111,\n      "\\u014b": 112,\n      "\\u0273": 113,\n      "\\u0272": 114,\n      "\\u0274": 115,\n      "\\u00f8": 116,\n      "\\u0278": 118,\n      "\\u03b8": 119,\n      "\\u0153": 120,\n      "\\u0279": 123,\n      "\\u027e": 125,\n      "\\u027b": 126,\n      "\\u0281": 128,\n      "\\u027d": 129,\n      "\\u0282": 130,\n      "\\u0283": 131,\n      "\\u0288": 132,\n      "\\u02a7": 133,\n      "\\u028a": 135,\n      "\\u028b": 136,\n      "\\u028c": 138,\n      "\\u0263": 139,\n      "\\u0264": 140,\n      "\\u03c7": 142,\n      "\\u028e": 143,\n      "\\u0292": 147,\n      "\\u0294": 148,\n      "\\u02c8": 156,\n      "\\u02cc": 157,\n      "\\u02d0": 158,\n      "\\u02b0": 162,\n      "\\u02b2": 164,\n      "\\u2193": 169,\n      "\\u2192": 171,\n      "\\u2197": 172,\n      "\\u2198": 173,\n      "\\u1d7b": 177\n    }\n  }\n}',
  'tokenizer_config.json':
    '{\n  "model_max_length": 512,\n  "pad_token": "$",\n  "tokenizer_class": "PreTrainedTokenizer",\n  "unk_token": "$"\n}',
};
