import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import { fileMinBytes, gateResult, workspaceFromGezel } from '@bendyline/gezel-sdk/checks';

export const meta = defineScript({
  name: 'checkFileMinBytes',
  description:
    'Gate: a workspace file exists and is at least minBytes long (optionally measured after trimming whitespace).',
  kind: 'gate',
  inputs: {
    file: { type: 'string', description: 'Workspace-relative file to check.', required: true },
    minBytes: {
      type: 'number',
      description: 'Minimum size in bytes.',
      required: true,
      integer: true,
      min: 1,
    },
    trim: {
      type: 'boolean',
      description: 'Trim surrounding whitespace before measuring.',
      default: false,
    },
  },
  outputs: {
    decision: { type: 'string', description: "'approve' or 'reject'." },
    message: { type: 'string', description: 'What passed, or the concrete gap to fix.' },
  },
  requires: ['workspace.read'],
} as const);

const input = gezel.input as InferredInput<typeof meta>;
const r = await fileMinBytes(workspaceFromGezel(gezel), input.file, input.minBytes, input.trim);
gezel.output(gateResult(r.ok, r.detail));
