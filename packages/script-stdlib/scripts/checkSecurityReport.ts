import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import { gateResult, securityReport, workspaceFromGezel } from '@bendyline/gezel-sdk/checks';

export const meta = defineScript({
  name: 'checkSecurityReport',
  description:
    'Gate: a whole-codebase security review is well-formed — the findings JSON parses, every finding cites a REAL file:line with a severity and a concrete remediation (no fabricated paths — the failure names them), the report carries the required sections, and (when there are enough findings to cluster) the Systemic Themes section names ≥ minThemes themes with root cause + blast radius; the verdict must match the open severity.',
  kind: 'gate',
  inputs: {
    file: {
      type: 'string',
      description: 'Workspace-relative report markdown (e.g. security-review/REPORT.md).',
      required: true,
    },
    findings: {
      type: 'string',
      description: 'Path to the machine-readable findings JSON.',
      default: 'security-review/findings.json',
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
  },
  outputs: {
    decision: { type: 'string', description: "'approve' or 'reject'." },
    message: { type: 'string', description: 'What passed, or the concrete gap to fix.' },
  },
  requires: ['workspace.read'],
} as const);

const input = gezel.input as InferredInput<typeof meta>;
const r = await securityReport(workspaceFromGezel(gezel), input.file, {
  findings: input.findings,
  minThemes: input.minThemes,
  themeThreshold: input.themeThreshold,
});
gezel.output(gateResult(r.ok, r.detail));
