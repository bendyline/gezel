/**
 * Read a GGUF's header from Hugging Face before downloading it: fetch the
 * first megabytes with a ranged request, parse, and fetch more only when the
 * header runs longer (a 256K-token vocabulary is ~6 MB). Capped, so a file
 * whose header claims to be enormous costs a bounded read and then fails.
 */

import { type GgufHeaderFacts, baseModelRefs } from '@bendyline/gezel';
import {
  GgufPrefixTooShortError,
  type GgufSummary,
  readGgufSummary,
  readGgufSummaryFromPrefix,
} from '../../providers/llama-cpp/gguf-metadata.js';
import {
  type WindowedKvInput,
  estimateKvReserveBytes,
  estimateLinearHybridKvLinearization,
  estimateWindowedKvLinearization,
} from '../../providers/llama-cpp/offload-planner.js';
import { fetchHubFilePrefix } from './hub.js';

const FIRST_READ_BYTES = 4 * 1024 * 1024;
export const MAX_HEADER_READ_BYTES = 64 * 1024 * 1024;

/** KV cost at f16 the way the catalog authors it: per context token, plus a fixed part. */
export function kvGeometryFromSummary(
  summary: GgufSummary,
): { kvBytesPerTokenF16: number; kvFixedBytesF16: number } | undefined {
  return kvGeometryFromInput(summary);
}

/** The same, from any attention geometry (an MLX `config.json` read remotely). */
export function kvGeometryFromInput(
  geometry: Omit<WindowedKvInput, 'kvCacheType'>,
): { kvBytesPerTokenF16: number; kvFixedBytesF16: number } | undefined {
  const input = { ...geometry, kvCacheType: 'f16' as const };
  const windowed = estimateWindowedKvLinearization(input);
  if (windowed && windowed.bytesPerToken > 0) {
    return { kvBytesPerTokenF16: windowed.bytesPerToken, kvFixedBytesF16: windowed.fixedBytes };
  }
  const hybrid = estimateLinearHybridKvLinearization(input);
  if (hybrid && hybrid.bytesPerToken > 0) {
    return { kvBytesPerTokenF16: hybrid.bytesPerToken, kvFixedBytesF16: hybrid.fixedBytes };
  }
  const perToken = estimateKvReserveBytes({ ...input, ctxTokens: 1 });
  return perToken && perToken > 0
    ? { kvBytesPerTokenF16: perToken, kvFixedBytesF16: 0 }
    : undefined;
}

export function headerFactsFromSummary(summary: GgufSummary): GgufHeaderFacts {
  const kv = kvGeometryFromSummary(summary);
  const contextLength =
    summary.contextLength !== undefined && summary.contextLength <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(summary.contextLength)
      : undefined;
  return {
    version: summary.version,
    ...(summary.architecture ? { architecture: summary.architecture } : {}),
    ...(summary.generalType ? { generalType: summary.generalType } : {}),
    ...(summary.adapterType ? { adapterType: summary.adapterType } : {}),
    ...(summary.name ? { name: summary.name } : {}),
    ...(summary.basename ? { basename: summary.basename } : {}),
    ...(summary.sizeLabel ? { sizeLabel: summary.sizeLabel } : {}),
    ...(summary.license ? { license: summary.license } : {}),
    ...(summary.organization ? { organization: summary.organization } : {}),
    ...(summary.baseModelUrls?.length ? { baseModels: baseModelRefs(summary.baseModelUrls) } : {}),
    ...(contextLength && contextLength > 0 ? { contextLength } : {}),
    ...(summary.fileTypeName ? { fileTypeName: summary.fileTypeName } : {}),
    ...(summary.chatTemplate ? { chatTemplate: summary.chatTemplate } : {}),
    ...(summary.tokenizerModel ? { tokenizerModel: summary.tokenizerModel } : {}),
    ...(summary.poolingType !== undefined ? { poolingType: summary.poolingType } : {}),
    ...(summary.expertCount !== undefined ? { expertCount: summary.expertCount } : {}),
    ...(summary.parameterCount !== undefined && (summary.splitCount ?? 1) <= 1
      ? { parameterCount: summary.parameterCount }
      : {}),
    ...(summary.tensorTypeCounts ? { tensorTypeCounts: summary.tensorTypeCounts } : {}),
    ...(summary.splitCount !== undefined ? { splitCount: summary.splitCount } : {}),
    ...(kv ? kv : {}),
  };
}

/** The header facts of a GGUF already on this computer (a local import's staged copy). */
export function readLocalGgufHeader(path: string): GgufHeaderFacts {
  return headerFactsFromSummary(readGgufSummary(path, { includeTensorTypes: true }));
}

/**
 * Parse the header of `path` at `commit`, reading as little as it takes.
 * Throws the parser's error for a file that is not a readable GGUF, or a
 * plain Error when the header does not fit in {@link MAX_HEADER_READ_BYTES}.
 */
export async function readRemoteGgufHeader(opts: {
  fetchImpl: typeof fetch;
  repo: string;
  commit: string;
  path: string;
  sizeBytes: number;
}): Promise<GgufHeaderFacts> {
  let want = Math.min(FIRST_READ_BYTES, Math.max(1, opts.sizeBytes));
  for (;;) {
    const prefix = await fetchHubFilePrefix(
      opts.fetchImpl,
      opts.repo,
      opts.commit,
      opts.path,
      want,
    );
    try {
      const summary = readGgufSummaryFromPrefix(prefix, opts.sizeBytes, {
        includeTensorTypes: true,
      });
      return headerFactsFromSummary(summary);
    } catch (err) {
      if (!(err instanceof GgufPrefixTooShortError)) throw err;
      if (prefix.length < want) {
        throw new Error('the download ended before the header did');
      }
      if (want >= MAX_HEADER_READ_BYTES || want >= opts.sizeBytes) {
        throw new Error(
          `its header is larger than ${Math.round(MAX_HEADER_READ_BYTES / 1024 ** 2)} MB, more than any model needs`,
        );
      }
      want = Math.min(MAX_HEADER_READ_BYTES, want * 4, opts.sizeBytes);
    }
  }
}
