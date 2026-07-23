import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import { citationsResolve, gateResult, workspaceFromGezel } from '@bendyline/gezel-sdk/checks';

export const meta = defineScript({
  name: 'checkCitationsResolve',
  description:
    'Gate: every source a file cites resolves to a real workspace file (the anti-fabrication gate). By default detects (source: path), Markdown links, and backticked paths; URLs are not checked offline unless a corpus allowlist is given.',
  kind: 'gate',
  inputs: {
    file: { type: 'string', description: 'Workspace-relative file to check.', required: true },
    pattern: {
      type: 'string',
      description:
        'Optional citation-extractor regex; first non-empty capture group is the cited path. Omit to use the built-in extractor.',
    },
    flags: { type: 'string', description: 'Regex flags for a custom pattern.', default: 'gi' },
    minCitations: {
      type: 'number',
      description: 'Minimum number of citations required.',
      default: 1,
      integer: true,
      min: 0,
    },
    corpus: {
      type: 'json',
      description:
        'Optional allowlist of acceptable paths/URLs. When set, every cited path AND URL must be a member.',
    },
  },
  outputs: {
    decision: { type: 'string', description: "'approve' or 'reject'." },
    message: { type: 'string', description: 'What passed, or the concrete gap to fix.' },
  },
  requires: ['workspace.read'],
} as const);

const input = gezel.input as InferredInput<typeof meta>;
const corpus = Array.isArray(input.corpus) ? input.corpus.map(String) : undefined;
const r = await citationsResolve(workspaceFromGezel(gezel), input.file, {
  pattern: input.pattern,
  flags: input.flags,
  minCitations: input.minCitations,
  corpus,
});
gezel.output(gateResult(r.ok, r.detail));
