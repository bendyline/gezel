/// <reference lib="dom" />
import { Tokenizer } from '@huggingface/tokenizers';
import { type MobileQueryModel, mobileQueryModels, queryModelStoreId } from './catalog.js';
import type { GezelKnowledgePlugin } from './definitions.js';

/** The same cap the desktop embedder applies before tokenizing (knowledge/src/embedding). */
const MAX_CHARS = 8_000;
/** KnowledgeFiles serves at most 8 MiB per range. */
const PIECE = 8 * 1024 * 1024;

async function readStoreFile(baseUrl: string, path: string): Promise<Uint8Array> {
  const url = baseUrl + path.split('/').map(encodeURIComponent).join('/');
  const pieces: Uint8Array[] = [];
  let total = Number.POSITIVE_INFINITY;
  for (let start = 0; start < total; start += PIECE) {
    const response = await fetch(url, {
      headers: { Range: `bytes=${start}-${start + PIECE - 1}` },
    });
    if (response.status !== 206)
      throw new Error(`Query model read failed (HTTP ${response.status})`);
    total = Number(/\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '')?.[1] ?? 0);
    pieces.push(new Uint8Array(await response.arrayBuffer()));
  }
  const out = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.length;
  }
  return out;
}

/** `profileUnitVector` (gezk): the profile's leading dimensions, renormalized. */
function unitVector(raw: readonly number[], dimensions: number): Float32Array {
  const vector = Float32Array.from(raw.slice(0, dimensions));
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm === 0)
    throw new Error('The query model returned an empty vector');
  for (let i = 0; i < vector.length; i++) vector[i] = vector[i]! / norm;
  return vector;
}

/**
 * Query vectors for a catalog's embedding profile, as the desktop embedder
 * makes them: the profile's query instruction, the profile's own tokenizer
 * (the library transformers.js uses), the pinned ONNX graph mean-pooled and
 * normalized on the device's ONNX Runtime, then the profile's projection.
 */
export function createQueryEmbedder(plugin: GezelKnowledgePlugin, baseUrl: () => Promise<string>) {
  const tokenizers = new Map<string, Promise<Tokenizer>>();
  const tokenizer = (model: MobileQueryModel) => {
    let pending = tokenizers.get(model.id);
    if (!pending) {
      pending = (async () => {
        const base = await baseUrl();
        const store = `/${queryModelStoreId(model.id)}/`;
        const json = (path: string) =>
          readStoreFile(base, store + path).then(
            (bytes) => JSON.parse(new TextDecoder().decode(bytes)) as object,
          );
        const [definition, config] = await Promise.all([
          json(model.tokenizer),
          json('tokenizer_config.json'),
        ]);
        return new Tokenizer(definition, config);
      })();
      // A failed load must not stay cached.
      void pending.catch(() => tokenizers.delete(model.id));
      tokenizers.set(model.id, pending);
    }
    return pending;
  };
  return {
    /** The query model for a profile, when this SDK knows how to fetch it. */
    model: (profileId: string) => mobileQueryModels.find((model) => model.id === profileId),
    async embed(profileId: string, query: string): Promise<Float32Array> {
      const model = mobileQueryModels.find((entry) => entry.id === profileId);
      if (!model) throw new Error(`No query model for ${profileId}`);
      const encoding = (await tokenizer(model)).encode(
        `${model.queryInstruction}${query}`.slice(0, MAX_CHARS),
      );
      // Truncate as the pipeline does: keep the closing special token.
      const ids =
        encoding.ids.length > model.maxTokens
          ? [...encoding.ids.slice(0, model.maxTokens - 1), encoding.ids.at(-1)!]
          : encoding.ids;
      const { vector } = await plugin.embed({
        model: queryModelStoreId(model.id),
        file: model.model,
        ids,
      });
      return unitVector(vector, model.dimensions);
    },
  };
}
