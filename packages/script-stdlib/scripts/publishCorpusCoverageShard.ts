import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';

/** Publish only bookkeeping after the service has verified full record reads. */
export const meta = defineScript({
  name: 'publishCorpusCoverageShard',
  description: 'Action: copy the exact paths and records of one verified review batch into its coverage shard after the read-evidence gate passes.',
  kind: 'action',
  inputs: {
    batchesFile: { type: 'string', description: 'Artifact path of the published batch array.', required: true },
    batchNumber: { type: 'string', description: 'One-based batch number.', required: true },
    outFile: { type: 'string', description: 'Artifact path of coverage-N.json.', required: true },
  },
  outputs: {
    ok: { type: 'boolean', description: 'True when the exact shard was written.' },
    outFile: { type: 'string', description: 'Artifact path written.' },
    files: { type: 'number', description: 'Number of reviewed paths copied.' },
  },
  requires: ['artifacts.read', 'artifacts.write'],
} as const);

const input = gezel.input as InferredInput<typeof meta>;
function cleanPath(raw: string, label: string): string {
  const value = raw.replace(/\\+/g, '/').replace(/^\.?\/+/, '').replace(/^artifacts\/+/i, '').trim();
  if (!value || value.split('/').includes('..')) throw new Error(`${label} must be a safe artifact-relative path.`);
  return value;
}
const batchesFile = cleanPath(input.batchesFile, 'batchesFile');
const outFile = cleanPath(input.outFile, 'outFile');
const number = Number(input.batchNumber);
if (!Number.isSafeInteger(number) || number < 1) throw new Error('batchNumber must be a positive integer.');
const raw = await gezel.artifacts.read(batchesFile);
let batches: unknown;
try { batches = JSON.parse(raw); } catch { throw new Error(`${batchesFile} is not valid JSON.`); }
if (!Array.isArray(batches)) throw new Error(`${batchesFile} must be a batch array.`);
const batch = batches.find((value) => value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).batchNumber === number) as Record<string, unknown> | undefined;
if (!batch || !Array.isArray(batch.paths) || !Array.isArray(batch.records) || batch.paths.length === 0 || batch.paths.length !== batch.records.length || batch.paths.some((value) => typeof value !== 'string') || batch.records.some((value) => typeof value !== 'string')) {
  throw new Error(`${batchesFile}: batch ${number} has invalid exact paths or records.`);
}
const content = JSON.stringify({ batchNumber: number, reviewedFiles: batch.paths, reviewedRecords: batch.records }, null, 2) + '\n';
await gezel.artifacts.write(outFile, content);
gezel.output({ ok: true, outFile, files: batch.paths.length });
