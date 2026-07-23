import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import { containsPattern, gateResult, workspaceFromGezel } from '@bendyline/gezel-sdk/checks';

export const meta = defineScript({
  name: 'checkContains',
  description:
    'Gate: a workspace file matches a regular expression — e.g. a "Game Over" marker, a required token, a section header.',
  kind: 'gate',
  inputs: {
    file: { type: 'string', description: 'Workspace-relative file to check.', required: true },
    pattern: { type: 'string', description: 'Regular expression to look for.', required: true },
    flags: { type: 'string', description: 'Regex flags, e.g. "i".', default: 'i' },
  },
  outputs: {
    decision: { type: 'string', description: "'approve' or 'reject'." },
    message: { type: 'string', description: 'What passed, or the concrete gap to fix.' },
  },
  requires: ['workspace.read'],
} as const);

const input = gezel.input as InferredInput<typeof meta>;
const r = await containsPattern(workspaceFromGezel(gezel), input.file, input.pattern, input.flags);
gezel.output(gateResult(r.ok, r.detail));
