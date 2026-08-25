import type { CheckResult } from './types.js';

export interface CorpusCoverageShardInput {
  path: string;
  content: string;
}

export interface CorpusCoverageLedger {
  pullRequest?: number;
  reviewedFiles: string[];
  reviewedRecords: string[];
  sources: Array<{ batchNumber: number; shard: string }>;
  complete: boolean;
}

export interface CorpusCoverageMergeResult extends CheckResult {
  ledger?: CorpusCoverageLedger;
  content?: string;
  expectedBatches: number;
  mergedBatches: number;
  missingBatches: number[];
}

interface CorpusBatch {
  batchNumber: number;
  paths: string[];
  records: string[];
}

function failure(detail: string): CorpusCoverageMergeResult {
  return {
    ok: false,
    detail,
    expectedBatches: 0,
    mergedBatches: 0,
    missingBatches: [],
  };
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item === '')) {
    return null;
  }
  return value as string[];
}

function firstMismatch(actual: string[], expected: string[]): number | null {
  if (actual.length !== expected.length) return Math.min(actual.length, expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) return index;
  }
  return null;
}

/**
 * Deterministically merge bounded corpus-coverage shards.
 *
 * The published batch manifest is the authority. Every accepted shard must
 * name exactly one batch and reproduce that batch's path and record arrays in
 * order; a parent cannot manufacture full-run coverage by copying paths that
 * no child shard reported. Missing shards may be merged for an in-progress
 * ledger, but malformed or out-of-scope shards always fail closed.
 */
export function mergeCorpusCoverageShards(
  batchesContent: string,
  shards: readonly CorpusCoverageShardInput[],
  opts: { pullRequest?: number; requireComplete?: boolean; batchesFile?: string } = {},
): CorpusCoverageMergeResult {
  const batchesFile = opts.batchesFile ?? 'batches.json';
  let batchesRaw: unknown;
  try {
    batchesRaw = JSON.parse(batchesContent);
  } catch (err) {
    return failure(
      `${batchesFile} is not valid JSON (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
  if (!Array.isArray(batchesRaw) || batchesRaw.length === 0) {
    return failure(`${batchesFile} must contain a non-empty batch array.`);
  }

  const batches: CorpusBatch[] = [];
  const allPaths = new Set<string>();
  const allRecords = new Set<string>();
  for (let index = 0; index < batchesRaw.length; index += 1) {
    const raw = batchesRaw[index];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return failure(`${batchesFile}[${index}] must be an object.`);
    }
    const fields = raw as Record<string, unknown>;
    const batchNumber = fields.batchNumber;
    const paths = parseStringArray(fields.paths);
    const records = parseStringArray(fields.records);
    if (!Number.isInteger(batchNumber) || batchNumber !== index + 1) {
      return failure(
        `${batchesFile}[${index}] must have batchNumber ${index + 1}; found ${JSON.stringify(batchNumber)}.`,
      );
    }
    if (!paths || paths.length === 0) {
      return failure(`${batchesFile}[${index}].paths must be a non-empty string array.`);
    }
    if (!records || records.length !== paths.length) {
      return failure(
        `${batchesFile}[${index}].records must contain one exact record path per changed path.`,
      );
    }
    for (const path of paths) {
      if (allPaths.has(path))
        return failure(`${batchesFile} assigns '${path}' to multiple batches.`);
      allPaths.add(path);
    }
    for (const record of records) {
      if (allRecords.has(record)) {
        return failure(`${batchesFile} assigns record '${record}' to multiple batches.`);
      }
      allRecords.add(record);
    }
    batches.push({ batchNumber: batchNumber as number, paths, records });
  }

  const shardByBatch = new Map<number, CorpusCoverageShardInput>();
  for (const shard of shards) {
    const normalized = shard.path.replace(/\\/g, '/');
    const match = /(?:^|\/)coverage-(\d+)\.json$/.exec(normalized);
    if (!match) continue;
    const batchNumber = Number(match[1]);
    if (batchNumber < 1 || batchNumber > batches.length) {
      return failure(
        `${shard.path} claims batch ${batchNumber}, but ${batchesFile} has batches 1-${batches.length}.`,
      );
    }
    if (shardByBatch.has(batchNumber)) {
      return failure(`More than one coverage shard claims batch ${batchNumber}.`);
    }
    shardByBatch.set(batchNumber, shard);
  }

  const reviewedFiles: string[] = [];
  const reviewedRecords: string[] = [];
  const sources: CorpusCoverageLedger['sources'] = [];
  for (const batch of batches) {
    const shard = shardByBatch.get(batch.batchNumber);
    if (!shard) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(shard.content);
    } catch (err) {
      return failure(
        `${shard.path} is not valid JSON (${err instanceof Error ? err.message : String(err)}).`,
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return failure(`${shard.path} must contain a JSON object.`);
    }
    const fields = parsed as Record<string, unknown>;
    if (fields.batchNumber !== batch.batchNumber) {
      return failure(
        `${shard.path} must declare batchNumber ${batch.batchNumber}; found ${JSON.stringify(fields.batchNumber)}.`,
      );
    }
    const files = parseStringArray(fields.reviewedFiles);
    const records = parseStringArray(fields.reviewedRecords);
    if (!files || !records) {
      return failure(`${shard.path} must contain reviewedFiles and reviewedRecords string arrays.`);
    }
    const fileMismatch = firstMismatch(files, batch.paths);
    if (fileMismatch !== null) {
      return failure(
        `${shard.path} does not exactly match batch ${batch.batchNumber}'s changed paths at position ${fileMismatch + 1}; coverage may only come from that batch's shard.`,
      );
    }
    const recordMismatch = firstMismatch(records, batch.records);
    if (recordMismatch !== null) {
      return failure(
        `${shard.path} does not exactly match batch ${batch.batchNumber}'s artifact records at position ${recordMismatch + 1}.`,
      );
    }
    reviewedFiles.push(...files);
    reviewedRecords.push(...records);
    sources.push({
      batchNumber: batch.batchNumber,
      shard: shard.path.replace(/\\/g, '/'),
    });
  }

  const missingBatches = batches
    .map((batch) => batch.batchNumber)
    .filter((batchNumber) => !shardByBatch.has(batchNumber));
  if (opts.requireComplete && missingBatches.length > 0) {
    return {
      ok: false,
      detail: `Coverage shards are still missing for batch${missingBatches.length === 1 ? '' : 'es'} ${missingBatches.join(', ')}.`,
      expectedBatches: batches.length,
      mergedBatches: sources.length,
      missingBatches,
    };
  }

  const ledger: CorpusCoverageLedger = {
    ...(opts.pullRequest !== undefined ? { pullRequest: opts.pullRequest } : {}),
    reviewedFiles,
    reviewedRecords,
    sources,
    complete: missingBatches.length === 0,
  };
  return {
    ok: true,
    detail:
      missingBatches.length === 0
        ? `Coverage is provenance-complete across all ${batches.length} batches and ${reviewedFiles.length} changed paths.`
        : `Merged ${sources.length}/${batches.length} coverage shards; waiting for batches ${missingBatches.join(', ')}.`,
    ledger,
    content: `${JSON.stringify(ledger, null, 2)}\n`,
    expectedBatches: batches.length,
    mergedBatches: sources.length,
    missingBatches,
  };
}
