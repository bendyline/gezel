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
    verificationCandidates: {
      type: 'number',
      description: 'Number of structured V-numbered cross-file candidates indexed.',
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
const NON_ACTIONABLE_RE =
  /\b(?:verified\s+ok|no\s+(?:defect|issue|finding|action\s+needed|functional\s+issue)|not\s+(?:a\s+bug|a\s+(?:functional|correctness)\s+defect|a\s+defect|introduced\s+by\s+this\s+patch|available\s+(?:in|for)\s+this\s+batch)|none\s+needed|acceptable(?:\s+as[- ]is)?|accept\s+as[- ]is|worth\s+noting|future\s+(?:optimization|hardening)|pre[- ]existing|functionally\s+harmless|intentional\s+limitation|needs?\s+(?:(?:central|cross[- ]file)\s+)?verification|requires?\s+(?:central\s+)?verification|central\s+verification|not\s+audited|implementation\s+(?:is\s+)?unknown|no\s+evidence\s+(?:of|that).{0,80}\bavailable|correct\s+(?:and\s+bounded\s+)?fallback|intent\s+is\s+correct|best[- ]effort|harmless\s+here|does\s+not\s+affect\s+runtime\s+behavior|finding\s+is\s+contingent|this\s+finding\s+is\s+contingent|risk\s+(?:is\s+)?low|may|might|could|potential(?:ly)?|possibly|likely|consider(?:ing)?|comment|documentation|documented|discoverability|verify\s+(?:that|the|whether)|verification\s+(?:of|whether)|(?:style|quoting|backslash)\s+(?:inconsistency|concern)|standardiz(?:e|ing)|if\s+.{0,160}\b(?:fails?|missing|empty|malformed|changes?|changed|removed|renamed|never|does\s+not|doesn't))\b/is;
const SHORTLIST_LIMIT = 8;
const UNKNOWN_SEVERITY_RANK = 3;
const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  major: 1,
  minor: 2,
  unknown: UNKNOWN_SEVERITY_RANK,
  nit: 4,
};
function severityRank(severity: string): number {
  return SEVERITY_RANK[severity] ?? UNKNOWN_SEVERITY_RANK;
}
const FINDING_START_RE = /^\s*(?:#{1,6}\s+|\*\*|[-*]\s+)?B(\d+)-(\d+)\b/i;
interface VerificationCandidate {
  id: string;
  path: string;
  line: number;
  severity: 'critical' | 'major' | 'minor' | 'nit';
  claim: string;
  verify: string;
  batchNumber: number;
  observationsFile: string;
}

function parseVerificationCandidates(
  content: string,
  batchNumber: number,
  observationsFile: string,
): VerificationCandidate[] {
  const heading = /^#{1,6}\s+Verification candidates\s*$/im.exec(content);
  // Older in-flight craftbook snapshots predate the structured channel.
  // Their gates never promised one, so absence remains an empty list. New
  // versions explicitly require the section in corpusBatchObservations.
  if (!heading) return [];
  const afterHeading = heading ? content.slice(heading.index + heading[0].length) : undefined;
  const nextHeadingOffset = afterHeading?.search(/^#{1,6}\s+/m) ?? -1;
  const section =
    afterHeading === undefined
      ? undefined
      : nextHeadingOffset >= 0
        ? afterHeading.slice(0, nextHeadingOffset)
        : afterHeading;
  const json = section ? /```json\s*([\s\S]*?)```/i.exec(section)?.[1] : undefined;
  if (!json) throw new Error(`${observationsFile} lacks its verificationCandidates JSON block.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `${observationsFile} has invalid verificationCandidates JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const raw =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).verificationCandidates
      : undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`${observationsFile} verificationCandidates must be an array.`);
  }
  return raw.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`${observationsFile} verificationCandidates[${index}] is invalid.`);
    }
    const fields = candidate as Record<string, unknown>;
    return {
      id: String(fields.id),
      path: String(fields.path),
      line: Number(fields.line),
      severity: String(fields.severity) as VerificationCandidate['severity'],
      claim: String(fields.claim),
      verify: String(fields.verify),
      batchNumber,
      observationsFile,
    };
  });
}

function scopeRank(preview: string): number {
  const path = /`([^`\n]+):\d+/.exec(preview)?.[1] ?? '';
  if (
    path.startsWith('evals/') ||
    path.startsWith('scripts/') ||
    path.startsWith('native/') ||
    /(?:^|\/)(?:test|tests|fixtures)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
  )
    return 2;
  if (/^packages\/[^/]+\/src\//.test(path)) return 0;
  return 1;
}
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
const indexedCandidates: Array<{
  id: string;
  severity: string;
  preview: string;
  likelyNonIssue: boolean;
  batchNumber: number;
  observationsFile: string;
  scopeRank: number;
}> = [];
const overflowCandidates: Array<{
  id: string;
  batchNumber: number;
  observationsFile: string;
}> = [];
const verificationCandidates: VerificationCandidate[] = [];
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
  const batchVerificationCandidates = parseVerificationCandidates(
    content,
    number,
    observationsFile,
  );
  verificationCandidates.push(...batchVerificationCandidates);
  const candidates = [];
  const overflow: string[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const match = FINDING_START_RE.exec(lines[lineIndex]!);
    if (!match) continue;
    const id = `B${match[1]}-${match[2]}`;
    const previewLines = [lines[lineIndex]!];
    for (let next = lineIndex + 1; next < lines.length && previewLines.length < 20; next++) {
      if (FINDING_START_RE.test(lines[next]!) || /^\s*#{1,4}\s+/.test(lines[next]!)) break;
      previewLines.push(lines[next]!);
    }
    const fullPreview = previewLines.join('\n');
    const severity =
      /\[(critical|major|minor|nit)\]|\b\**severity\**\s*(?::|\||—|-)?\s*\**(critical|major|minor|nit)\b|(?:^|\|)\s*\**(critical|major|minor|nit)\**\s*(?:\||$)|\b(critical|major|minor|nit)\s*:|\((critical|major|minor|nit)\)|(?:—|-)\s*\**(critical|major|minor|nit)\**\s*(?:(?:—|-)|$)/im.exec(
        fullPreview,
      );
    const normalizedSeverity = (
      severity?.[1] ??
      severity?.[2] ??
      severity?.[3] ??
      severity?.[4] ??
      severity?.[5] ??
      severity?.[6] ??
      'unknown'
    ).toLowerCase();
    const candidateScopeRank = scopeRank(fullPreview);
    const likelyNonIssue =
      NON_ACTIONABLE_RE.test(fullPreview) ||
      (candidateScopeRank === 2 && !['critical', 'major'].includes(normalizedSeverity));
    const preview = fullPreview.slice(0, likelyNonIssue ? 240 : 520);
    if (candidates.length < 20) {
      candidates.push({
        id,
        severity: normalizedSeverity,
        preview,
        likelyNonIssue,
      });
      indexedCandidates.push({
        id,
        severity: normalizedSeverity,
        preview,
        likelyNonIssue,
        batchNumber: number,
        observationsFile,
        scopeRank: candidateScopeRank,
      });
    } else {
      overflow.push(id);
      overflowCandidates.push({ id, batchNumber: number, observationsFile });
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
    candidateIds: candidates.map((candidate) => candidate.id),
    nonActionableIds: candidates
      .filter((candidate) => candidate.likelyNonIssue)
      .map((candidate) => candidate.id),
    overflow,
    verificationCandidateIds: batchVerificationCandidates.map((candidate) => candidate.id),
  });
}
const actionableCandidates = indexedCandidates
  .filter((candidate) => !candidate.likelyNonIssue)
  .sort(
    (left, right) =>
      severityRank(left.severity) - severityRank(right.severity) ||
      left.scopeRank - right.scopeRank ||
      left.batchNumber - right.batchNumber ||
      left.id.localeCompare(right.id),
  );
const shortlist = actionableCandidates.slice(0, SHORTLIST_LIMIT);
const omittedActionable = [
  ...actionableCandidates.slice(SHORTLIST_LIMIT).map((candidate) => ({
    id: candidate.id,
    severity: candidate.severity,
    batchNumber: candidate.batchNumber,
    observationsFile: candidate.observationsFile,
  })),
  ...overflowCandidates.map((candidate) => ({ ...candidate, severity: 'unknown' })),
];
verificationCandidates.sort(
  (left, right) =>
    severityRank(left.severity) - severityRank(right.severity) ||
    left.batchNumber - right.batchNumber ||
    left.id.localeCompare(right.id),
);
await gezel.artifacts.write(
  outFile,
  `${JSON.stringify(
    {
      schemaVersion: 2,
      batchesFile,
      batchCount: summaries.length,
      candidateCount,
      actionableCandidateCount: actionableCandidates.length + overflowCandidates.length,
      nonActionableCandidateCount: indexedCandidates.filter((candidate) => candidate.likelyNonIssue)
        .length,
      shortlistLimit: SHORTLIST_LIMIT,
      shortlist,
      omittedActionable,
      verificationCandidates,
      batches: summaries,
    },
    null,
    2,
  )}\n`,
);
gezel.output({
  ok: true,
  outFile,
  batches: summaries.length,
  candidates: candidateCount,
  verificationCandidates: verificationCandidates.length,
});
