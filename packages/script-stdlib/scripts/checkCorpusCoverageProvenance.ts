import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import { gateResult, mergeCorpusCoverageShards } from '@bendyline/gezel-sdk/checks';

export const meta = defineScript({
  name: 'checkCorpusCoverageProvenance',
  description:
    'Gate: every published corpus batch has one exact coverage-N.json shard, and the merged run ledger is byte-semantically identical to the deterministic union of those shards. Prevents a parent from inventing coverage for missing child work.',
  kind: 'gate',
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
    ledgerFile: {
      type: 'string',
      description: 'Artifact path of the merged run ledger to verify.',
      required: true,
    },
    pullRequest: { type: 'string', description: 'Expected pull request number in the ledger.' },
  },
  outputs: {
    decision: { type: 'string', description: "'approve' or 'reject'." },
    message: { type: 'string', description: 'What passed, or the concrete provenance gap.' },
  },
  requires: ['artifacts.read'],
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
const ledgerFile = cleanPath(input.ledgerFile, 'ledgerFile');
const pullRequest = input.pullRequest === undefined ? undefined : Number(input.pullRequest);
if (pullRequest !== undefined && (!Number.isInteger(pullRequest) || pullRequest < 1)) {
  throw new Error('pullRequest must be a positive integer when supplied.');
}
const batchesContent = await gezel.artifacts.read(batchesFile).catch(() => null);
if (batchesContent === null) {
  gezel.output(gateResult(false, `${batchesFile} is missing; provenance cannot be verified.`));
} else {
  const entries = await gezel.artifacts.list(shardDir, { recursive: true }).catch(() => []);
  const shards = await Promise.all(
    entries
      .map((entry) => entry.path.replace(/\\+/g, '/'))
      .filter((path) => /(?:^|\/)coverage-\d+\.json$/.test(path))
      .sort()
      .map(async (path) => ({ path, content: await gezel.artifacts.read(path) })),
  );
  const merged = mergeCorpusCoverageShards(batchesContent, shards, {
    ...(pullRequest !== undefined ? { pullRequest } : {}),
    requireComplete: true,
    batchesFile,
  });
  if (!merged.ok || !merged.ledger) {
    gezel.output(gateResult(false, merged.detail));
  } else {
    const ledgerContent = await gezel.artifacts.read(ledgerFile).catch(() => null);
    let actual: unknown = null;
    try {
      actual = ledgerContent === null ? null : JSON.parse(ledgerContent);
    } catch {
      actual = null;
    }
    const matches = JSON.stringify(actual) === JSON.stringify(merged.ledger);
    gezel.output(
      gateResult(
        matches,
        matches
          ? merged.detail
          : `${ledgerFile} is not the deterministic union of the validated coverage shards. Do not add paths by hand; let mergeCorpusCoverage rebuild it on the next activation.`,
      ),
    );
  }
}
