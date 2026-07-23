import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import { fileMinLines, gateResult, workspaceFromGezel } from '@bendyline/gezel-sdk/checks';

export const meta = defineScript({
  name: 'checkFileMinLines',
  description: 'Gate: a workspace file has at least minLines non-blank lines.',
  kind: 'gate',
  inputs: {
    file: { type: 'string', description: 'Workspace-relative file to check.', required: true },
    minLines: {
      type: 'number',
      description: 'Minimum count of non-blank lines.',
      required: true,
      integer: true,
      min: 1,
    },
  },
  outputs: {
    decision: { type: 'string', description: "'approve' or 'reject'." },
    message: { type: 'string', description: 'What passed, or the concrete gap to fix.' },
  },
  requires: ['workspace.read'],
} as const);

const input = gezel.input as InferredInput<typeof meta>;
const r = await fileMinLines(workspaceFromGezel(gezel), input.file, input.minLines);
gezel.output(gateResult(r.ok, r.detail));
