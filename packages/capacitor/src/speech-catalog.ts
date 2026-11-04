/**
 * Speech models a phone can download. The Whisper files and Kokoro voices are
 * the pinned files of `@bendyline/gezel/speech-models` (desktop), repeated
 * here because that entry reads the file system; speech-catalog.test.ts holds
 * the two in step. Kokoro differs only in weights: desktop's fp32 export is
 * 326 MB, so phones take the int8 export of the same timestamped model, which
 * keeps word timings and every voice.
 */
export interface MobileSpeechFile {
  /** Path inside the model folder, `/`-separated. */
  readonly name: string;
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
}

export interface MobileSpeechVoice {
  readonly id: string;
  readonly label: string;
  /** BCP 47 tag. */
  readonly language: string;
  readonly gender: 'female' | 'male';
}

export interface MobileSpeechModel {
  readonly id: string;
  readonly kind: 'stt' | 'tts';
  readonly label: string;
  readonly description: string;
  readonly recommended: boolean;
  readonly license: string;
  readonly licenseUrl: string;
  /** The file the engine loads: Whisper weights, or Kokoro's ONNX graph. */
  readonly model: string;
  readonly files: readonly MobileSpeechFile[];
  /** Kokoro only; each voice is `voices/<id>.bin`. */
  readonly voices?: readonly MobileSpeechVoice[];
}

const WHISPER_COMMIT = '5359861c739e955e79d9a303bcbc70fb988958b1';
const KOKORO_MODEL_COMMIT = 'dd4401a9add81ac692d20e240d22ec9dda82cc29';
const KOKORO_VOICES_COMMIT = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';
/** 510 style vectors × 256 float32 values per voice. */
const KOKORO_VOICE_BYTES = 522_240;
export const KOKORO_MOBILE_MODEL_FILE = 'onnx/model_quantized.onnx';
export const KOKORO_SAMPLE_RATE = 24_000;

function whisper(
  id: string,
  label: string,
  description: string,
  file: string,
  sha256: string,
  size: number,
  recommended: boolean,
): MobileSpeechModel {
  return {
    id,
    kind: 'stt',
    label,
    description,
    recommended,
    license: 'MIT',
    licenseUrl: 'https://github.com/openai/whisper/blob/main/LICENSE',
    model: file,
    files: [
      {
        name: file,
        url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_COMMIT}/${file}`,
        sha256,
        size,
      },
    ],
  };
}

const VOICES: readonly (MobileSpeechVoice & { readonly sha256: string })[] = (
  [
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
  ] as const
).map(([id, label, language, gender, sha256]) => ({ id, label, language, gender, sha256 }));

export const MOBILE_SPEECH_MODELS: readonly MobileSpeechModel[] = [
  whisper(
    'whisper-tiny.en',
    'Whisper Tiny (English)',
    'Fastest. Good for short notes.',
    'ggml-tiny.en.bin',
    '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f',
    77_704_715,
    false,
  ),
  whisper(
    'whisper-base.en',
    'Whisper Base (English)',
    'Recommended. More accurate; a little slower.',
    'ggml-base.en.bin',
    'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002',
    147_964_211,
    true,
  ),
  {
    id: 'kokoro-82m-v1.0',
    kind: 'tts',
    label: 'Kokoro (English voices)',
    description: 'Natural US and UK English narration voices.',
    recommended: true,
    license: 'Apache-2.0',
    licenseUrl: 'https://huggingface.co/hexgrad/Kokoro-82M/blob/main/LICENSE',
    model: KOKORO_MOBILE_MODEL_FILE,
    files: [
      {
        name: KOKORO_MOBILE_MODEL_FILE,
        url: `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped/resolve/${KOKORO_MODEL_COMMIT}/${KOKORO_MOBILE_MODEL_FILE}`,
        sha256: 'c0c02b3299fd97c34ea92a98e6d41eaa1a739c8f77bf685aac34bd7b34c1132c',
        size: 92_361_055,
      },
      ...VOICES.map((voice) => ({
        name: `voices/${voice.id}.bin`,
        url: `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/${KOKORO_VOICES_COMMIT}/voices/${voice.id}.bin`,
        sha256: voice.sha256,
        size: KOKORO_VOICE_BYTES,
      })),
    ],
    voices: VOICES.map(({ id, label, language, gender }) => ({ id, label, language, gender })),
  },
];

export const KOKORO_DEFAULT_VOICE = 'af_heart';

export function mobileSpeechModel(id: string): MobileSpeechModel | undefined {
  return MOBILE_SPEECH_MODELS.find((model) => model.id === id);
}

export function speechDownloadBytes(model: MobileSpeechModel): number {
  return model.files.reduce((sum, file) => sum + file.size, 0);
}
