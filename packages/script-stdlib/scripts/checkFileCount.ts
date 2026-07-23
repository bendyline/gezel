import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import { fileCountByExt, gateResult, workspaceFromGezel } from '@bendyline/gezel-sdk/checks';

export const meta = defineScript({
  name: 'checkFileCount',
  description:
    'Gate: at least minCount workspace files with one of the given extensions exist (optionally under a directory) — e.g. ≥ 3 images.',
  kind: 'gate',
  inputs: {
    extensions: {
      type: 'string',
      description: 'Comma-separated extensions, e.g. "png,jpg,svg".',
      required: true,
    },
    minCount: {
      type: 'number',
      description: 'Minimum number of matching files.',
      required: true,
      integer: true,
      min: 1,
    },
    dir: { type: 'string', description: 'Restrict to this directory (optional).' },
  },
  outputs: {
    decision: { type: 'string', description: "'approve' or 'reject'." },
    message: { type: 'string', description: 'What passed, or the concrete gap to fix.' },
  },
  requires: ['workspace.read'],
} as const);

const input = gezel.input as InferredInput<typeof meta>;
const ext = input.extensions
  .split(',')
  .map((e) => e.trim())
  .filter(Boolean);
const r = await fileCountByExt(workspaceFromGezel(gezel), ext, input.minCount, input.dir);
gezel.output(gateResult(r.ok, r.detail));
