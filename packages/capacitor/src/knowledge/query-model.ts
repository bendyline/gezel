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
 *
 * `embedPassage` embeds text exactly as given, for an app that stores its own
 * passages: their embed input (`passageEmbedInput` in gezel-knowledge)
 * already carries the profile's passage instruction and context header.
 */
export function createQueryEmbedder(plugin: GezelKnowledgePlugin, baseUrl: () => Promise<string>) {
  const files = new Map<string, Promise<{ definition: string; config: string }>>();
  const tokenizers = new Map<string, Promise<Tokenizer>>();
  /** The tokenizer files as text, read once per model; a failed read is not kept. */
  const tokenizerFiles = (model: MobileQueryModel) => {
    let pending = files.get(model.id);
    if (!pending) {
      pending = (async () => {
        const base = await baseUrl();
        const store = `/${queryModelStoreId(model.id)}/`;
        const text = (path: string) =>
          readStoreFile(base, store + path).then((bytes) => new TextDecoder().decode(bytes));
        const [definition, config] = await Promise.all([
          text(model.tokenizer),
          text('tokenizer_config.json'),
        ]);
        return { definition, config };
      })();
      void pending.catch(() => files.delete(model.id));
      files.set(model.id, pending);
    }
    return pending;
  };
  const tokenizer = (model: MobileQueryModel) => {
    let pending = tokenizers.get(model.id);
    if (!pending) {
      pending = tokenizerFiles(model).then(
        ({ definition, config }) =>
          new Tokenizer(JSON.parse(definition) as object, JSON.parse(config) as object),
      );
      // A failed load must not stay cached.
      void pending.catch(() => tokenizers.delete(model.id));
      tokenizers.set(model.id, pending);
    }
    return pending;
  };
  const modelFor = (profileId: string) => {
    const model = mobileQueryModels.find((entry) => entry.id === profileId);
    if (!model) throw new Error(`No query model for ${profileId}`);
    return model;
  };
  const embedText = async (model: MobileQueryModel, text: string): Promise<Float32Array> => {
    const encoding = (await tokenizer(model)).encode(text.slice(0, MAX_CHARS));
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
  };
  return {
    /** The query model for a profile, when this SDK knows how to fetch it. */
    model: (profileId: string) => mobileQueryModels.find((model) => model.id === profileId),
    async embed(profileId: string, query: string): Promise<Float32Array> {
      const model = modelFor(profileId);
      return embedText(model, `${model.queryInstruction}${query}`);
    },
    /** A stored passage's vector: its embed input exactly as given. */
    async embedPassage(profileId: string, input: string): Promise<Float32Array> {
      return embedText(modelFor(profileId), input);
    },
    /** The profile's `tokenizer.json` and `tokenizer_config.json`, as text. */
    async tokenizerFiles(profileId: string): Promise<{ definition: string; config: string }> {
      return tokenizerFiles(modelFor(profileId));
    },
  };
}
