/**
 * Does the image show what the prompt asked for? Scored with the product's
 * own text and image encoders (EmbeddingGemma 2, the media-search profile),
 * so no new model and no network: the cosine between the prompt and the
 * image, and where the image's own prompt ranks among every prompt in the
 * suite. A rank of 1 means the image is closer to its prompt than to any
 * other.
 *
 * An embedding sees subject and style, not spelling or counting, so a sign
 * reading "OPNE" scores like one reading "OPEN". Text and composition are
 * for a reviewer; this is the cheap check that the model drew the right
 * thing at all.
 */
import {
  KNOWLEDGE_EMBEDDING_PROFILES,
  createProfileEmbedder,
  profileUnitVector,
} from '@bendyline/gezel-knowledge';
import { decodeImage, loadMediaEncoder, rgbaToRgb } from '@bendyline/gezel-service/media';

const PROFILE_ID = 'embeddinggemma-2-512@1';

export interface AlignmentScore {
  /** Cosine between the image and its own prompt. */
  cosine: number;
  /** 1-based rank of the image's own prompt among every suite prompt. */
  rank: number;
  /** Own cosine minus the best other prompt's; negative when another prompt wins. */
  margin: number;
}

export interface AlignmentScorer {
  score(png: Buffer, promptId: string): Promise<AlignmentScore>;
  dispose(): Promise<void>;
}

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
  return s;
};

export async function createAlignmentScorer(opts: {
  hfCache: string;
  prompts: ReadonlyArray<{ id: string; prompt: string }>;
}): Promise<AlignmentScorer> {
  const profile = KNOWLEDGE_EMBEDDING_PROFILES.find((p) => p.id === PROFILE_ID);
  if (!profile) throw new Error(`${PROFILE_ID} is not a registered knowledge profile`);
  const load = { cacheDir: opts.hfCache, localFilesOnly: true };
  const text = await createProfileEmbedder(profile, load);
  const prompts = new Map<string, Float32Array>();
  for (const p of opts.prompts)
    prompts.set(p.id, Float32Array.from(await text.embedQuery(p.prompt)));
  await text.dispose();
  const encoder = await loadMediaEncoder(profile, { ...load, modalities: ['image'] });
  return {
    async score(png, promptId) {
      const own = prompts.get(promptId);
      if (!own) throw new Error(`no embedded prompt "${promptId}"`);
      const raw = await encoder.embedImage(rgbaToRgb(decodeImage(png)));
      const image = profileUnitVector(profile, Float32Array.from(raw));
      const cosine = dot(own, image);
      let rank = 1;
      let bestOther = Number.NEGATIVE_INFINITY;
      for (const [id, vector] of prompts) {
        if (id === promptId) continue;
        const c = dot(vector, image);
        if (c > cosine) rank++;
        if (c > bestOther) bestOther = c;
      }
      return { cosine, rank, margin: cosine - bestOther };
    },
    dispose: () => encoder.dispose(),
  };
}
