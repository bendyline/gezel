import { estimateTokens } from '@bendyline/gezel';
import { embedModelId } from '../../memory/embed-core.js';
import { EmbeddingsDisabledError, embedBatch } from '../../memory/embeddings.js';
import type { InferenceContext } from '../inference-context.js';
import { resolveModelTarget } from './translate.js';

/**
 * Names the on-device text embedder whichever model it is configured to run.
 * Persona ids are `gezel:<role>-<name>` and always contain a hyphen, so this
 * can never collide with one.
 */
export const LOCAL_EMBEDDING_MODEL_ALIAS = 'gezel:embeddings';

/** OpenAI's own per-request input limit; one caller must not monopolize the shared embed worker. */
export const MAX_EMBEDDING_INPUTS = 2048;

/**
 * Whether `model` addresses the on-device embedder: the alias, the configured
 * model id (`Xenova/bge-small-en-v1.5`), or its bare name (`bge-small-en-v1.5`,
 * the form Ollama clients send).
 */
export function isLocalEmbeddingModel(model: string): boolean {
  const wanted = model.trim().toLowerCase();
  const id = embedModelId().toLowerCase();
  return (
    wanted === LOCAL_EMBEDDING_MODEL_ALIAS ||
    wanted === id ||
    wanted === id.slice(id.lastIndexOf('/') + 1)
  );
}

export type EmbeddingsOutcome =
  | {
      ok: true;
      vectors: number[][];
      /** The model that produced the vectors: the embedder's id for the local path. */
      model: string;
      inputTokens: number;
    }
  | {
      ok: false;
      status: 400 | 404 | 500 | 503;
      code:
        | 'model_not_found'
        | 'embeddings_not_supported'
        | 'embeddings_unavailable'
        | 'provider_error';
      message: string;
    };

/**
 * Embed `input` for the OpenAI and Ollama embedding routes.
 *
 * The local path uses passage-side embedding (`embedBatch`): these APIs do not
 * say whether a text is a query or a document, and bge needs no passage prefix.
 * A chat model is never silently swapped for the embedder — vectors from a
 * different model would corrupt the caller's index — so a provider without
 * `createEmbedding` gets an error that names the alias instead.
 */
export async function createEmbeddings(
  ctx: Pick<InferenceContext, 'chat'>,
  model: string,
  input: string | string[],
): Promise<EmbeddingsOutcome> {
  if (isLocalEmbeddingModel(model)) {
    const texts = typeof input === 'string' ? [input] : input;
    try {
      const vectors = await embedBatch(texts);
      return {
        ok: true,
        vectors,
        model: embedModelId(),
        inputTokens: texts.reduce((sum, text) => sum + estimateTokens(text), 0),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return err instanceof EmbeddingsDisabledError
        ? { ok: false, status: 503, code: 'embeddings_unavailable', message }
        : { ok: false, status: 500, code: 'provider_error', message };
    }
  }

  const target = resolveModelTarget(model);
  if (!target) {
    return {
      ok: false,
      status: 404,
      code: 'model_not_found',
      message: `Unknown model "${model}". Expected "<provider>:<model>", or "${LOCAL_EMBEDDING_MODEL_ALIAS}" for on-device embeddings.`,
    };
  }
  const unsupported: EmbeddingsOutcome = {
    ok: false,
    status: 400,
    code: 'embeddings_not_supported',
    message: `Provider "${target.provider}" does not support embeddings. Use "${LOCAL_EMBEDDING_MODEL_ALIAS}" for on-device embeddings.`,
  };
  // Asking a local engine for a model can admit and start it; only a host
  // that can look a provider up without binding a model asks it at all.
  if (!ctx.chat.getProvider) return unsupported;
  try {
    const provider = await ctx.chat.getProvider(target.provider);
    if (!provider.createEmbedding) return unsupported;
    const result = await provider.createEmbedding({
      input,
      ...(target.model ? { model: target.model } : {}),
    });
    return { ok: true, vectors: result.vectors, model, inputTokens: result.usage.inputTokens };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 500, code: 'provider_error', message };
  }
}
