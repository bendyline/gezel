import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import { codebaseReviewReport, gateResult, workspaceFromGezel } from '@bendyline/gezel-sdk/checks';

export const meta = defineScript({
  name: 'checkCodebaseReviewReport',
  description:
    'Gate: a comprehensive codebase review is well-formed — the findings JSON parses, every finding cites a REAL workspace file with a severity, title, and concrete remediation (critical/high pinned to a line; fabricated paths are named), the report carries the required consultant sections with a per-dimension Scorecard table, systemic themes analyze root cause + blast radius once there is enough material, and the executive summary matches the open severity. Report and findings are read from the artifacts drawer; cited files are verified against the workspace.',
  kind: 'gate',
  inputs: {
    file: {
      type: 'string',
      description: 'Artifact path of the review report markdown.',
      required: true,
    },
    findings: {
      type: 'string',
      description: 'Artifact path of the machine-readable findings JSON.',
      required: true,
    },
    minThemes: {
      type: 'number',
      description: 'Systemic themes required once findings ≥ themeThreshold.',
      default: 2,
      integer: true,
      min: 0,
    },
    themeThreshold: {
      type: 'number',
      description: 'Findings count at/above which systemic-theme synthesis is required.',
      default: 3,
      integer: true,
      min: 0,
    },
    minScorecardRows: {
      type: 'number',
      description: 'Minimum dimension rows the Scorecard table must carry.',
      default: 4,
      integer: true,
      min: 1,
    },
  },
  outputs: {
    decision: { type: 'string', description: "'approve' or 'reject'." },
    message: { type: 'string', description: 'What passed, or the concrete gap to fix.' },
  },
  requires: ['artifacts.read', 'workspace.read'],
} as const);

const input = gezel.input as InferredInput<typeof meta>;

function cleanArtifactPath(raw: unknown, label: string): string {
  const value = String(raw ?? '')
    .replace(/\\+/g, '/')
    .replace(/^\.?\/+/, '')
    .replace(/^artifacts\/+/i, '')
    .trim();
  if (!value) throw new Error(`${label} must be a non-empty artifact path.`);
  if (value.includes('{{')) {
    throw new Error(`${label} still contains an uninterpolated placeholder: ${value}`);
  }
  return value;
}

const reportFile = cleanArtifactPath(input.file, 'file');
const findingsFile = cleanArtifactPath(input.findings, 'findings');

// The deliverables live in the artifacts drawer; the files they cite live in
// the workspace. Two surfaces, one check — `workspaceFromGezel` covers the
// citation side, and the drawer side only ever needs `read`.
const drawer = {
  read: async (file: string) => {
    try {
      return await gezel.artifacts.read(file);
    } catch {
      return null;
    }
  },
  list: async () => [],
};

const r = await codebaseReviewReport(drawer, workspaceFromGezel(gezel), reportFile, {
  findings: findingsFile,
  minThemes: input.minThemes,
  themeThreshold: input.themeThreshold,
  minScorecardRows: input.minScorecardRows,
});
gezel.output(gateResult(r.ok, r.detail));
