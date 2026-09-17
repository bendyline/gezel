export type TestEmbed = (texts: string[]) => Promise<number[][]>;

export interface PrewarmTestEmbedderOptions {
  attempts?: number;
  retryDelayMs?: number;
  embed?: TestEmbed;
}

async function defaultEmbed(texts: string[]): Promise<number[][]> {
  const { runEmbed } = await import('../memory/embed-core.js');
  return runEmbed(texts);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/**
 * Download, parse, and execute the small embedding model before Vitest forks.
 * A successful vector is the verification: unlike checking for a file, this
 * proves the cached ONNX protobuf is complete and loadable.
 */
export async function prewarmTestEmbedder(options: PrewarmTestEmbedderOptions = {}): Promise<void> {
  const attempts = options.attempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 2_000;
  const embed = options.embed ?? defaultEmbed;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error('prewarm attempts must be a positive integer');
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const [vector] = await embed(['verified CI embedding cache warmup']);
      if (!vector || vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
        throw new Error('embedding model returned an invalid warmup vector');
      }
      return;
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await delay(retryDelayMs);
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `could not prewarm the test embedding model after ${attempts} attempts: ${detail}`,
    {
      cause: lastError,
    },
  );
}
