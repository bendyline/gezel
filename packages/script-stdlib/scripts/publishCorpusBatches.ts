import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';

/**
 * Publish a connector corpus's own batch manifest as a fanout input artifact.
 *
 * A declarative fanout reads `spawn.overFile` — a JSON array, one entry per
 * child. When the corpus already ships that array (the `github-pulls`
 * connector writes deterministic 25-file batches into its manifest), asking a
 * model to retype it is pure loss: the paths are the gate keys for every child
 * reviewer, and token emission is the wrong transport for data that already
 * exists on disk.
 *
 * Wild-caught on a 509-file pull request. The batch array is 25 KB — roughly
 * 7.3k tokens of arguments — against a 6144-token per-turn cap, so the write
 * was arithmetically impossible. Two cap-length attempts were rejected, a
 * third landed valid-but-truncated JSON holding 10 of 21 batches, and the
 * scope gate (json-valid + minBytes) passed it: 259 changed files would have
 * been dropped from the review with no signal until the downstream merge gate
 * deadlocked. Running this instead costs no model tokens and cannot truncate.
 *
 * Validation is deliberately strict and fails loudly — a batch file that is
 * quietly wrong produces gates no child reviewer can ever pass.
 */

export const meta = defineScript({
  name: 'publishCorpusBatches',
  description:
    "Action: copy a connector corpus manifest's batch array into a fanout-input artifact, verbatim, with completeness checks against the manifest's own file total.",
  kind: 'action',
  inputs: {
    corpusDir: {
      type: 'string',
      description:
        'Artifact-relative directory the connector mirrored the corpus into (e.g. data/github-pull-requests/pr-33).',
      required: true,
    },
    outFile: {
      type: 'string',
      description:
        "Artifact path to write the batch array to. Must match the craftbook's `spawn.overFile`.",
      required: true,
    },
    manifestSuffix: {
      type: 'string',
      description:
        'Filename suffix identifying the manifest inside the corpus (default: -files.json).',
    },
    itemsField: {
      type: 'string',
      description: 'Manifest field holding the batch array (default: batches).',
    },
    totalField: {
      type: 'string',
      description:
        'Manifest field holding the expected total item count the batches must cover (default: totalFiles). Set empty to skip the total cross-check.',
    },
  },
  outputs: {
    ok: { type: 'boolean', description: 'True when the artifact was written; failures throw.' },
    manifest: { type: 'string', description: 'Artifact path of the manifest that was read.' },
    outFile: { type: 'string', description: 'Artifact path that was written.' },
    batches: { type: 'number', description: 'Number of batch entries published.' },
    paths: { type: 'number', description: 'Total distinct paths across every batch.' },
    bytes: { type: 'number', description: 'Size of the written artifact in bytes.' },
  },
  requires: ['artifacts.read', 'artifacts.write'],
} as const);

const input = gezel.input as InferredInput<typeof meta>;

function fail(message: string): never {
  throw new Error(message);
}

function cleanPath(raw: unknown, label: string): string {
  // A craftbook's `corpusScope` param is authored as `artifacts/data/...` for
  // the model-facing prose; the drawer API is already scoped there, so the
  // redundant prefix is stripped here exactly as read/write strip it.
  const value = String(raw ?? '')
    .replace(/\\+/g, '/')
    .replace(/^\.?\/+/, '')
    .replace(/^artifacts\/+/i, '')
    .replace(/\/+$/, '')
    .trim();
  if (!value) fail(`${label} must be a non-empty artifact-relative path.`);
  if (value.split('/').includes('..')) fail(`${label} must not contain '..' segments.`);
  return value;
}

const corpusDir = cleanPath(input.corpusDir, 'corpusDir');
const outFile = cleanPath(input.outFile, 'outFile');
const manifestSuffix = String(input.manifestSuffix ?? '-files.json');
const itemsField = String(input.itemsField ?? 'batches');
const totalField = input.totalField === undefined ? 'totalFiles' : String(input.totalField);

const entries = await gezel.artifacts.list(corpusDir, { recursive: true });
const candidates = entries
  .map((entry) => entry.path.replace(/\\+/g, '/'))
  .filter((path) => path.endsWith(manifestSuffix))
  .sort();
if (candidates.length === 0) {
  fail(
    `No '*${manifestSuffix}' manifest under artifacts/${corpusDir}. The connector corpus is missing or was never synced, so there is nothing to fan out over.`,
  );
}
// Ambiguity is a real failure, not a coin flip: picking the wrong manifest
// would fan the crew out over the wrong pull request.
if (candidates.length > 1) {
  fail(
    `Found ${candidates.length} '*${manifestSuffix}' manifests under artifacts/${corpusDir}: ${candidates.join(', ')}. Narrow corpusDir to one record.`,
  );
}
const manifestPath = candidates[0]!;

const raw = await gezel.artifacts.read(manifestPath);
let manifest: unknown;
try {
  manifest = JSON.parse(raw);
} catch (err) {
  fail(
    `artifacts/${manifestPath} is not valid JSON (${err instanceof Error ? err.message : String(err)}).`,
  );
}
if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
  fail(`artifacts/${manifestPath} must contain a JSON object.`);
}
const manifestFields = manifest as Record<string, unknown>;

const itemsRaw = manifestFields[itemsField];
if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) {
  fail(`artifacts/${manifestPath} has no non-empty '${itemsField}' array to fan out over.`);
}

interface Batch {
  batchNumber: number;
  start: number;
  end: number;
  paths: string[];
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

const seenPaths = new Set<string>();
const batches: Batch[] = itemsRaw.map((item, index) => {
  const where = `${itemsField}[${index}] of artifacts/${manifestPath}`;
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    fail(`${where} is not an object.`);
  }
  const fields = item as Record<string, unknown>;
  // `batchNumber` over `number`: a fanout child addresses its own fields as
  // `{{key}}`, and launch params interpolate first — a book launched with a
  // `number` param would shadow the batch's own.
  const batchNumber = fields.batchNumber ?? fields.number;
  if (!isPositiveInt(batchNumber)) fail(`${where} has no positive integer batchNumber.`);
  if (batchNumber !== index + 1) {
    fail(
      `${where} has batchNumber ${batchNumber} at position ${index + 1}. Batch numbers must be 1..N in order — the fanout addresses children by this value.`,
    );
  }
  const { start, end } = fields;
  if (!isPositiveInt(start) || !isPositiveInt(end) || end < start) {
    fail(`${where} has an invalid start/end ordinal range.`);
  }
  const pathsRaw = fields.paths;
  if (
    !Array.isArray(pathsRaw) ||
    pathsRaw.length === 0 ||
    pathsRaw.some((value) => typeof value !== 'string' || value.trim() === '')
  ) {
    fail(`${where} has no non-empty array of path strings.`);
  }
  const paths = pathsRaw as string[];
  if (paths.length !== end - start + 1) {
    fail(
      `${where} spans ordinals ${start}-${end} (${end - start + 1} files) but carries ${paths.length} paths.`,
    );
  }
  for (const path of paths) {
    // Every path must land in exactly one batch: a duplicate silently double-
    // reviews one file while the coverage arithmetic still looks complete.
    if (seenPaths.has(path))
      fail(`${where} repeats '${path}', which another batch already claims.`);
    seenPaths.add(path);
  }
  return { batchNumber, start, end, paths };
});

if (totalField !== '') {
  const expectedTotal = manifestFields[totalField];
  if (!isPositiveInt(expectedTotal)) {
    fail(
      `artifacts/${manifestPath} has no positive integer '${totalField}' to verify batch coverage against (fail-closed).`,
    );
  }
  if (seenPaths.size !== expectedTotal) {
    fail(
      `artifacts/${manifestPath} declares ${totalField}=${expectedTotal} but its ${itemsField} cover ${seenPaths.size} distinct paths. The manifest is internally inconsistent; fanning out over it would drop or duplicate work.`,
    );
  }
}

const content = `${JSON.stringify(batches, null, 2)}\n`;
await gezel.artifacts.write(outFile, content);

gezel.output({
  ok: true,
  manifest: manifestPath,
  outFile,
  batches: batches.length,
  paths: seenPaths.size,
  bytes: content.length,
});
