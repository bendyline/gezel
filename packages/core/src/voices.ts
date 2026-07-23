// Kokoro TTS voice catalog. Mirrors the `VOICES` table inside `kokoro-js`
// (we keep it duplicated here so packages that don't depend on the service
// can pick a voice deterministically — e.g. for assigning one to a new
// gezel at creation time). When the upstream voice list grows, append
// here; ids are stable, so an existing gezel's `voice` keeps resolving.

import type { GezelGender } from './schemas/gezel.js';

export interface KokoroVoiceInfo {
  id: string;
  name: string;
  language: 'en-US' | 'en-GB';
  gender: 'male' | 'female';
  /** Upstream's overall quality grade — used to weight the random picker. */
  grade: 'A' | 'A-' | 'B+' | 'B' | 'B-' | 'C+' | 'C' | 'C-' | 'D+' | 'D' | 'D-' | 'F+';
}

/**
 * Full Kokoro voice catalog. Source: the `VOICES` dict in
 * `kokoro-js@1.2.1/dist/kokoro.js` (model card on the HF repo
 * `onnx-community/Kokoro-82M-v1.0-ONNX`). Grades reflect upstream's
 * subjective overall ranking; the picker prefers higher grades so the
 * average gezel sounds decent.
 */
export const KOKORO_VOICES: readonly KokoroVoiceInfo[] = [
  { id: 'af_heart', name: 'Heart', language: 'en-US', gender: 'female', grade: 'A' },
  { id: 'af_bella', name: 'Bella', language: 'en-US', gender: 'female', grade: 'A-' },
  { id: 'af_nicole', name: 'Nicole', language: 'en-US', gender: 'female', grade: 'B-' },
  { id: 'af_aoede', name: 'Aoede', language: 'en-US', gender: 'female', grade: 'C+' },
  { id: 'af_kore', name: 'Kore', language: 'en-US', gender: 'female', grade: 'C+' },
  { id: 'af_sarah', name: 'Sarah', language: 'en-US', gender: 'female', grade: 'C+' },
  { id: 'af_alloy', name: 'Alloy', language: 'en-US', gender: 'female', grade: 'C' },
  { id: 'af_nova', name: 'Nova', language: 'en-US', gender: 'female', grade: 'C' },
  { id: 'af_sky', name: 'Sky', language: 'en-US', gender: 'female', grade: 'C-' },
  { id: 'af_jessica', name: 'Jessica', language: 'en-US', gender: 'female', grade: 'D' },
  { id: 'af_river', name: 'River', language: 'en-US', gender: 'female', grade: 'D' },
  { id: 'am_michael', name: 'Michael', language: 'en-US', gender: 'male', grade: 'C+' },
  { id: 'am_fenrir', name: 'Fenrir', language: 'en-US', gender: 'male', grade: 'C+' },
  { id: 'am_puck', name: 'Puck', language: 'en-US', gender: 'male', grade: 'C+' },
  { id: 'am_echo', name: 'Echo', language: 'en-US', gender: 'male', grade: 'D' },
  { id: 'am_eric', name: 'Eric', language: 'en-US', gender: 'male', grade: 'D' },
  { id: 'am_liam', name: 'Liam', language: 'en-US', gender: 'male', grade: 'D' },
  { id: 'am_onyx', name: 'Onyx', language: 'en-US', gender: 'male', grade: 'D' },
  { id: 'am_santa', name: 'Santa', language: 'en-US', gender: 'male', grade: 'D-' },
  { id: 'am_adam', name: 'Adam', language: 'en-US', gender: 'male', grade: 'F+' },
  { id: 'bf_emma', name: 'Emma', language: 'en-GB', gender: 'female', grade: 'B-' },
  { id: 'bf_isabella', name: 'Isabella', language: 'en-GB', gender: 'female', grade: 'C' },
  { id: 'bf_alice', name: 'Alice', language: 'en-GB', gender: 'female', grade: 'D' },
  { id: 'bf_lily', name: 'Lily', language: 'en-GB', gender: 'female', grade: 'D' },
  { id: 'bm_george', name: 'George', language: 'en-GB', gender: 'male', grade: 'C' },
  { id: 'bm_fable', name: 'Fable', language: 'en-GB', gender: 'male', grade: 'C' },
  { id: 'bm_lewis', name: 'Lewis', language: 'en-GB', gender: 'male', grade: 'D+' },
  { id: 'bm_daniel', name: 'Daniel', language: 'en-GB', gender: 'male', grade: 'D' },
];

const KOKORO_VOICE_BY_ID = new Map(KOKORO_VOICES.map((v) => [v.id, v]));

export function findKokoroVoice(id: string): KokoroVoiceInfo | undefined {
  return KOKORO_VOICE_BY_ID.get(id);
}

export function isValidKokoroVoice(id: string): boolean {
  return KOKORO_VOICE_BY_ID.has(id);
}

// Weight grades so the picker leans toward higher-quality voices but
// occasionally surfaces the longer tail (otherwise every gezel would
// end up sounding like one of three voices).
const GRADE_WEIGHT: Record<KokoroVoiceInfo['grade'], number> = {
  A: 8,
  'A-': 7,
  'B+': 6,
  B: 5,
  'B-': 4,
  'C+': 3,
  C: 2,
  'C-': 2,
  'D+': 1,
  D: 1,
  'D-': 1,
  'F+': 1,
};

/**
 * Pick a Kokoro voice id appropriate for a gezel's gender. `male` →
 * `am_*`/`bm_*` voices; `female` → `af_*`/`bf_*`. `non-binary` draws
 * uniformly from the full catalog so the assignment doesn't lean on
 * the catalog's male/female split. Quality grade biases the weighting
 * within the eligible pool.
 *
 * Deterministic when a `seed` is supplied — used by tests and by the
 * createGezel path so the same id always picks the same voice on a
 * re-roll. Without a seed, `Math.random` drives the draw.
 */
export function pickKokoroVoiceForGender(
  gender: GezelGender | undefined,
  opts: { seed?: number } = {},
): string {
  const pool = KOKORO_VOICES.filter((v) => {
    if (gender === 'male') return v.gender === 'male';
    if (gender === 'female') return v.gender === 'female';
    return true; // non-binary or unknown → full catalog
  });
  if (pool.length === 0) {
    // Should never happen — catalog has both genders. Fall back to af_heart.
    return 'af_heart';
  }
  const rng = opts.seed === undefined ? Math.random : seededRng(opts.seed);
  const totalWeight = pool.reduce((sum, v) => sum + GRADE_WEIGHT[v.grade], 0);
  let pick = rng() * totalWeight;
  for (const voice of pool) {
    pick -= GRADE_WEIGHT[voice.grade];
    if (pick <= 0) return voice.id;
  }
  return pool[pool.length - 1]!.id;
}

function seededRng(seed: number): () => number {
  // Mulberry32 — small + deterministic; matches the style used in
  // poppetje/seed.ts.
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
