import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import { mergeCorpusCoverageShards } from '@bendyline/gezel-sdk/checks';

export const meta = defineScript({
  name: 'mergeCorpusCoverage',
  description:
    'Action: deterministically merge the coverage-N.json shards that exactly match their published corpus batches into one provenance-stamped run ledger. Missing shards produce an in-progress ledger; malformed or out-of-batch shards fail closed.',
  kind: 'action',
  inputs: {
    batchesFile: {
      type: 'string',
      description: 'Artifact path of the runtime-published batch array.',
      required: true,
    },
    shardDir: {
      type: 'string',
      description: 'Artifact directory containing coverage-N.json shards.',
      required: true,
    },
    outFile: {
      type: 'string',
      description: 'Artifact path for the deterministic merged ledger.',
      required: true,
    },
    pullRequest: { type: 'string', description: 'Pull request number to stamp in the ledger.' },
  },
  outputs: {
    ok: { type: 'boolean', description: 'True when a valid ledger was written.' },
    outFile: { type: 'string', description: 'Artifact path written.' },
    expectedBatches: { type: 'number', description: 'Published batch count.' },
    mergedBatches: { type: 'number', description: 'Validated shard count merged.' },
    missingBatches: { type: 'json', description: 'Batch numbers still missing.' },
    complete: { type: 'boolean', description: 'True when every batch shard was present.' },
  },
  requires: ['artifacts.read', 'artifacts.write'],
} as const);

const input = gezel.input as InferredInput<typeof meta>;

function cleanPath(raw: string, label: string): string {
  const value = raw
    .replace(/\\+/g, '/')
    .replace(/^\.?\/+/, '')
    .replace(/^artifacts\/+/i, '')
    .replace(/\/+$/, '')
    .trim();
  if (!value || value.split('/').includes('..')) {
    throw new Error(`${label} must be a safe artifact-relative path.`);
  }
  return value;
}

const batchesFile = cleanPath(input.batchesFile, 'batchesFile');
const shardDir = cleanPath(input.shardDir, 'shardDir');
const outFile = cleanPath(input.outFile, 'outFile');
const pullRequest = input.pullRequest === undefined ? undefined : Number(input.pullRequest);
if (pullRequest !== undefined && (!Number.isInteger(pullRequest) || pullRequest < 1)) {
  throw new Error('pullRequest must be a positive integer when supplied.');
}
const batchesContent = await gezel.artifacts.read(batchesFile);
const entries = await gezel.artifacts.list(shardDir, { recursive: true });
const shards = await Promise.all(
  entries
    .map((entry) => entry.path.replace(/\\+/g, '/'))
    .filter((path) => /(?:^|\/)coverage-\d+\.json$/.test(path))
    .sort()
    .map(async (path) => ({ path, content: await gezel.artifacts.read(path) })),
);
const merged = mergeCorpusCoverageShards(batchesContent, shards, {
  ...(pullRequest !== undefined ? { pullRequest } : {}),
  batchesFile,
});
if (!merged.ok || !merged.content || !merged.ledger) throw new Error(merged.detail);

await gezel.artifacts.write(outFile, merged.content);
gezel.output({
  ok: true,
  outFile,
  expectedBatches: merged.expectedBatches,
  mergedBatches: merged.mergedBatches,
  missingBatches: merged.missingBatches,
  complete: merged.ledger.complete,
});
