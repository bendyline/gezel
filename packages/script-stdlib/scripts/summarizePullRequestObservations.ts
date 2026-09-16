import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';

/** Compact, deterministic synthesis input from every gated PR-review shard. */
export const meta = defineScript({
  name: 'summarizePullRequestObservations',
  description:
    'Action: read every exact review-batch observations shard and publish a compact candidate index without copying all shard prose into the final reviewer prompt.',
  kind: 'action',
  inputs: {
    batchesFile: {
      type: 'string',
      description: 'Exact artifact path of the published batch array.',
      required: true,
    },
    shardDir: {
      type: 'string',
      description: 'Artifact directory containing observations-N.md shards.',
      required: true,
    },
    outFile: {
      type: 'string',
      description: 'Artifact path of the compact synthesis index.',
      required: true,
    },
  },
  outputs: {
    ok: { type: 'boolean', description: 'True when every shard was indexed.' },
    outFile: { type: 'string', description: 'Artifact path written.' },
    batches: { type: 'number', description: 'Number of observations shards indexed.' },
    candidates: {
      type: 'number',
      description: 'Number of B-numbered findings candidates indexed.',
    },
  },
  requires: ['artifacts.read', 'artifacts.write'],
} as const);

const input = gezel.input as InferredInput<typeof meta>;
function cleanPath(raw: string): string {
  const value = raw
    .replace(/\\+/g, '/')
    .replace(/^\.?\/+/, '')
    .replace(/^artifacts\/+/, '')
    .replace(/\/+$/, '')
    .trim();
  if (!value || value.split('/').includes('..'))
    throw new Error('Expected a safe artifact-relative path.');
  return value;
}

const batchesFile = cleanPath(input.batchesFile);
const shardDir = cleanPath(input.shardDir);
const outFile = cleanPath(input.outFile);
let parsed: unknown;
try {
  parsed = JSON.parse(await gezel.artifacts.read(batchesFile));
} catch (error) {
  throw new Error(
    `Could not read review batches: ${error instanceof Error ? error.message : String(error)}`,
  );
}
if (!Array.isArray(parsed) || parsed.length === 0)
  throw new Error('Review batches must be a non-empty array.');

const summaries = [];
let candidateCount = 0;
for (let index = 0; index < parsed.length; index++) {
  const value = parsed[index];
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Batch ${index + 1} is not an object.`);
  const batch = value as Record<string, unknown>;
  if (
    batch.batchNumber !== index + 1 ||
    !Array.isArray(batch.paths) ||
    batch.paths.length === 0 ||
    batch.paths.some((path) => typeof path !== 'string')
  ) {
    throw new Error(`Batch ${index + 1} has invalid numbering or changed paths.`);
  }
  const number = index + 1;
  const observationsFile = `${shardDir}/observations-${number}.md`;
  let content: string;
  try {
    content = await gezel.artifacts.read(observationsFile);
  } catch {
    throw new Error(
      `Missing exact observations shard ${observationsFile}; synthesis cannot use a subset.`,
    );
  }
  const lines = content.split(/\r?\n/);
  const headings = lines
    .filter((line) => /^\s*#{1,6}\s+/.test(line))
    .map((line) => line.replace(/^\s*#{1,6}\s+/, '').replace(/`/g, ''));
  const missingPaths = (batch.paths as string[]).filter(
    (path) => !headings.some((heading) => heading === path || heading.startsWith(`${path} `)),
  );
  if (missingPaths.length > 0)
    throw new Error(
      `${observationsFile} lacks path heading(s): ${missingPaths.slice(0, 5).join(', ')}`,
    );
  const candidates = [];
  const overflow: string[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const match = /^\s*(?:#{1,6}\s+|\*\*|[-*]\s+)?B(\d+)-(\d+)\b/i.exec(lines[lineIndex]!);
    if (!match) continue;
    const id = `B${match[1]}-${match[2]}`;
    const previewLines = [lines[lineIndex]!];
    for (let next = lineIndex + 1; next < lines.length && previewLines.length < 7; next++) {
      if (/\bB\d+-\d+\b/.test(lines[next]!) || /^\s*#{1,4}\s+/.test(lines[next]!)) break;
      previewLines.push(lines[next]!);
    }
    const preview = previewLines.join('\n').slice(0, 750);
    const severity = /\[(critical|major|minor|nit)\]|\b(critical|major|minor|nit)\s*:/i.exec(
      preview,
    );
    if (candidates.length < 20) {
      candidates.push({
        id,
        severity: (severity?.[1] ?? severity?.[2] ?? 'unknown').toLowerCase(),
        preview,
        likelyNonIssue:
          /\b(?:verified ok|no issue|no finding|not a bug|none needed|functionally harmless|pre-existing|not introduced by this patch)\b/i.test(
            preview,
          ),
      });
    } else {
      overflow.push(id);
    }
  }
  candidateCount += candidates.length + overflow.length;
  summaries.push({
    batchNumber: number,
    start: batch.start,
    end: batch.end,
    paths: batch.paths.length,
    observationsFile,
    bytes: new TextEncoder().encode(content).length,
    candidates,
    overflow,
  });
}
await gezel.artifacts.write(
  outFile,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      batchesFile,
      batchCount: summaries.length,
      candidateCount,
      batches: summaries,
    },
    null,
    2,
  )}\n`,
);
gezel.output({ ok: true, outFile, batches: summaries.length, candidates: candidateCount });
