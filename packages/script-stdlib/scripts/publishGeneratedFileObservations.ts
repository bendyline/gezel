import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import { generatedBatchObservations, generatedFileKind } from '@bendyline/gezel-sdk/checks';

/**
 * Write the observations and coverage shard for every batch of generated
 * files (lockfiles, third-party notices) without a model turn.
 *
 * A reviewer adds nothing to these line by line, and they are large: on a
 * 57-file pull request one lockfile and seven notices files were 49% of the
 * patch text, queued as reviewer batches behind a single local engine. The
 * shards have the shape a reviewer's batch has, so the coverage merge, its
 * provenance check and the synthesis index need no second path.
 */
export const meta = defineScript({
  name: 'publishGeneratedFileObservations',
  description:
    "Action: for each published batch marked `generated`, summarize its files' patches into observations-N.md and write coverage-N.json, so generated files are accounted for without a reviewer.",
  kind: 'action',
  inputs: {
    batchesFile: {
      type: 'string',
      description: 'Artifact path of the runtime-published batch array.',
      required: true,
    },
    shardDir: {
      type: 'string',
      description: 'Artifact directory the observations-N.md and coverage-N.json shards go in.',
      required: true,
    },
  },
  outputs: {
    ok: { type: 'boolean', description: 'True when every generated batch was written.' },
    batches: { type: 'number', description: 'Generated batches written.' },
    files: { type: 'number', description: 'Generated files summarized.' },
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
let batches: unknown;
try {
  batches = JSON.parse(await gezel.artifacts.read(batchesFile));
} catch (error) {
  throw new Error(
    `Could not read ${batchesFile}: ${error instanceof Error ? error.message : String(error)}`,
  );
}
if (!Array.isArray(batches)) throw new Error(`${batchesFile} must be a batch array.`);

let written = 0;
let files = 0;
for (const value of batches) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
  const batch = value as Record<string, unknown>;
  if (batch.generated !== true) continue;
  const { batchNumber, start, end, paths, records } = batch;
  if (
    !Number.isSafeInteger(batchNumber) ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Array.isArray(paths) ||
    !Array.isArray(records) ||
    paths.length === 0 ||
    paths.length !== records.length ||
    paths.some((path) => typeof path !== 'string') ||
    records.some((record) => typeof record !== 'string')
  ) {
    throw new Error(`${batchesFile}: a generated batch has invalid bounds, paths or records.`);
  }
  const summarized = await Promise.all(
    (paths as string[]).map(async (path, index) => {
      const kind = generatedFileKind(path);
      // Marked by the connector with this same rule; a mismatch means the
      // batch file was not written by this build, and its coverage is not
      // something to vouch for.
      if (!kind) {
        throw new Error(
          `${batchesFile}: batch ${batchNumber} is marked generated, but ${path} is not a generated file.`,
        );
      }
      const record = await gezel.artifacts.read((records as string[])[index]!).catch(() => null);
      return { path, kind, record };
    }),
  );
  await gezel.artifacts.write(
    `${shardDir}/observations-${batchNumber}.md`,
    generatedBatchObservations({
      batchNumber: batchNumber as number,
      start: start as number,
      end: end as number,
      files: summarized,
    }),
  );
  await gezel.artifacts.write(
    `${shardDir}/coverage-${batchNumber}.json`,
    `${JSON.stringify({ batchNumber, reviewedFiles: paths, reviewedRecords: records }, null, 2)}\n`,
  );
  written += 1;
  files += paths.length;
}

gezel.output({ ok: true, batches: written, files });
