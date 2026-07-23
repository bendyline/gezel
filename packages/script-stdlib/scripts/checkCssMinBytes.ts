import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import { cssMinBytes, gateResult, workspaceFromGezel } from '@bendyline/gezel-sdk/checks';

export const meta = defineScript({
  name: 'checkCssMinBytes',
  description:
    'Gate: real styling exists — inline <style> plus linked local stylesheets in an HTML file total at least minBytes.',
  kind: 'gate',
  inputs: {
    file: { type: 'string', description: 'HTML file to inspect.', default: 'index.html' },
    minBytes: {
      type: 'number',
      description: 'Minimum combined CSS bytes.',
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
const r = await cssMinBytes(workspaceFromGezel(gezel), input.minBytes, input.file);
gezel.output(gateResult(r.ok, r.detail));
