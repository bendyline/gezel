import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';

/** Compact scope evidence; the full manifest and batches remain gate inputs. */
export const meta = defineScript({
  name: 'summarizePullRequestCorpus',
  description:
    'Action: summarize a published PR corpus manifest and batch array into small scope metadata without sending every path and record to the model.',
  kind: 'action',
  inputs: {
    manifestFile: {
      type: 'string',
      description: 'Exact artifact path of the PR file manifest.',
      required: true,
    },
    batchesFile: {
      type: 'string',
      description: 'Artifact path of the runtime-published batch array.',
      required: true,
    },
    outFile: {
      type: 'string',
      description: 'Artifact path of the compact scope summary.',
      required: true,
    },
  },
  outputs: {
    ok: { type: 'boolean', description: 'True when scope metadata was written.' },
    outFile: { type: 'string', description: 'Artifact path written.' },
    files: { type: 'number', description: 'Changed-file count.' },
    batches: { type: 'number', description: 'Review-batch count.' },
  },
  requires: ['artifacts.read', 'artifacts.write'],
} as const);

const input = gezel.input as InferredInput<typeof meta>;
function path(raw: string): string {
  const value = raw
    .replace(/\\+/g, '/')
    .replace(/^\.?\/+/, '')
    .replace(/^artifacts\/+/i, '')
    .trim();
  if (!value || value.split('/').includes('..'))
    throw new Error('Expected a safe artifact-relative path.');
  return value;
}
const manifestFile = path(input.manifestFile);
const batchesFile = path(input.batchesFile);
const outFile = path(input.outFile);
let manifest: unknown;
let batches: unknown;
try {
  manifest = JSON.parse(await gezel.artifacts.read(manifestFile));
  batches = JSON.parse(await gezel.artifacts.read(batchesFile));
} catch (error) {
  throw new Error(
    `Could not parse PR scope inputs: ${error instanceof Error ? error.message : String(error)}`,
  );
}
if (
  !manifest ||
  typeof manifest !== 'object' ||
  Array.isArray(manifest) ||
  !Array.isArray(batches) ||
  batches.length === 0
) {
  throw new Error('PR scope inputs must contain a manifest object and a non-empty batch array.');
}
const fields = manifest as Record<string, unknown>;
const totalFiles = fields.totalFiles;
const files = fields.files;
if (!Number.isSafeInteger(totalFiles) || !Array.isArray(files) || files.length !== totalFiles) {
  throw new Error('PR manifest totalFiles does not match its file array.');
}
const ranges = batches.map((value, index) => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Batch ${index + 1} is not an object.`);
  const batch = value as Record<string, unknown>;
  if (
    batch.batchNumber !== index + 1 ||
    !Number.isSafeInteger(batch.start) ||
    !Number.isSafeInteger(batch.end) ||
    !Array.isArray(batch.paths)
  ) {
    throw new Error(`Batch ${index + 1} has invalid numbering or bounds.`);
  }
  return { number: index + 1, start: batch.start, end: batch.end, files: batch.paths.length };
});
const distribution = new Map<string, number>();
for (const value of files) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
  const changedPath = (value as Record<string, unknown>).path;
  if (typeof changedPath !== 'string') continue;
  const area = changedPath.split('/')[0] ?? '?';
  distribution.set(area, (distribution.get(area) ?? 0) + 1);
}
const topAreas = [...distribution]
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .slice(0, 10)
  .map(([area, count]) => ({ area, count }));
const content = `${JSON.stringify(
  {
    manifestFile,
    pullRequest: fields.pullRequest,
    totalFiles,
    batchCount: ranges.length,
    ranges,
    topAreas,
  },
  null,
  2,
)}\n`;
await gezel.artifacts.write(outFile, content);
gezel.output({ ok: true, outFile, files: totalFiles as number, batches: ranges.length });
