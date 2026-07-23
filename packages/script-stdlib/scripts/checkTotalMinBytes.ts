import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import { gateResult, totalMinBytes, workspaceFromGezel } from '@bendyline/gezel-sdk/checks';

export const meta = defineScript({
  name: 'checkTotalMinBytes',
  description:
    'Gate: the combined size of several workspace files clears a floor (e.g. index.html + game.js ≥ 5000 bytes).',
  kind: 'gate',
  inputs: {
    files: {
      type: 'json',
      description: 'Array of workspace-relative file paths, e.g. ["index.html", "game.js"].',
      required: true,
    },
    minBytes: {
      type: 'number',
      description: 'Minimum combined size in bytes.',
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
const files = Array.isArray(input.files) ? input.files.map(String) : [String(input.files)];
const r = await totalMinBytes(workspaceFromGezel(gezel), files, input.minBytes);
gezel.output(gateResult(r.ok, r.detail));
